import type { Express } from "express";
import { createServer, type Server } from "http";
import { mongoStorage } from "./mongoStorage";
import { setupSimpleAuth, isAuthenticated, isAdmin } from "./simpleAuth";
import { insertProjectSchema, insertFileSchema, insertAiConversationSchema, insertUserPreferencesSchema, insertProjectDataSchema } from "@shared/schema";
import { generateCode, explainCode, debugCode, chatWithAI } from "./gemini-ai.js";
import { parseAndCreateProjectFiles } from "./codeParser.js";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileSystemSync } from "./fileSystemSync.js";

// Authorization helpers
function normalizeId(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return value._id.toString();
  return value.toString();
}

function isAdminUser(req: any): boolean {
  return !!req.user?.isAdmin;
}

async function assertProjectWriteAccess(req: any, projectId: string): Promise<{ok: boolean, code?: number, msg?: string}> {
  try {
    console.log('=== DEBUG: assertProjectWriteAccess ===');
    console.log('User object:', req.user);
    console.log('Is Admin?:', req.user?.isAdmin);
    console.log('Project ID:', projectId);
    
    // Admin users can access any project
    if (isAdminUser(req)) {
      console.log('✅ Admin access granted');
      return { ok: true };
    }

    // Load project
    const project = await mongoStorage.getProject(projectId);
    if (!project) {
      console.log('❌ Project not found');
      return { ok: false, code: 404, msg: "Project not found" };
    }

    // Check if user is project owner
    const userId = normalizeId(req.user.id || req.user._id);
    const projectOwnerId = normalizeId(project.ownerId);
    
    console.log('User ID:', userId);
    console.log('Project Owner ID:', projectOwnerId);
    console.log('IDs match?:', projectOwnerId === userId);
    
    if (projectOwnerId === userId) {
      console.log('✅ Owner access granted');
      return { ok: true };
    }

    console.log('❌ Access denied - not admin and not owner');
    return { ok: false, code: 403, msg: "Access denied" };
  } catch (error) {
    console.error('Error checking project access:', error);
    return { ok: false, code: 500, msg: "Internal server error" };
  }
}

async function assertFileWriteAccess(req: any, fileId: string): Promise<{ok: boolean, code?: number, msg?: string}> {
  try {
    // First get the file
    const file = await mongoStorage.getFile(fileId);
    if (!file) {
      return { ok: false, code: 404, msg: "File not found" };
    }

    // Then check project access
    return await assertProjectWriteAccess(req, normalizeId(file.projectId));
  } catch (error) {
    console.error('Error checking file access:', error);
    return { ok: false, code: 500, msg: "Internal server error" };
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupSimpleAuth(app);

  // Note: Auth routes are now handled in simpleAuth.ts

app.get("/logo.png", (req, res) => {
    const logoPath = path.join(process.cwd(), "logo.png");
    res.sendFile(logoPath);
  });   

  // Project routes
  app.get('/api/projects', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const projects = await mongoStorage.getUserProjects(userId);
      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  // AI-powered project creation with multi-file support
  app.post('/api/projects/ai-create', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { prompt, name, language = 'react' } = req.body;
      
      if (!prompt) {
        return res.status(400).json({ message: "AI prompt is required" });
      }

      // Create project first
      const projectName = name || `AI Project - ${new Date().toLocaleString()}`;
      const projectData = {
        name: projectName,
        description: `Generated from prompt: ${prompt}`,
        ownerId: userId,
        isPublic: false,
      };
      
      const project = await mongoStorage.createProject(projectData);
      
      // Parse AI-generated code into separate files
      console.log('Creating multi-file AI project for prompt:', prompt, 'Language:', language);
      const parsedProject = await parseAndCreateProjectFiles(prompt, projectName, language);
      
      // First, create necessary folders
      const foldersToCreate = new Set<string>();
      for (const file of parsedProject.files) {
        const pathParts = file.path.split('/').filter(part => part);
        let currentPath = '';
        for (let i = 0; i < pathParts.length - 1; i++) {
          currentPath += '/' + pathParts[i];
          foldersToCreate.add(currentPath);
        }
      }

      // Create folders first
      for (const folderPath of Array.from(foldersToCreate).sort()) {
        try {
          const folderName = folderPath.split('/').pop() || '';
          await mongoStorage.createFile({
            projectId: project.id,
            name: folderName,
            path: folderPath,
            content: null,
            isFolder: true,
          });
          console.log(`Created folder: ${folderPath}`);
        } catch (folderError) {
          console.error(`Error creating folder ${folderPath}:`, folderError);
        }
      }

      // Then create all the parsed files
      const createdFiles = [];
      for (const file of parsedProject.files) {
        try {
          const createdFile = await mongoStorage.createFile({
            projectId: project.id,
            name: file.name,
            path: file.path,
            content: file.content,
            isFolder: false,
          });
          createdFiles.push(createdFile);
          console.log(`Created file: ${file.name} (${file.language})`);
        } catch (fileError) {
          console.error(`Error creating file ${file.name}:`, fileError);
        }
      }

      res.json({ 
        project,
        files: createdFiles,
        structure: parsedProject.projectStructure,
        message: `AI project created with ${createdFiles.length} files! Each language has its own dedicated file.`
      });
    } catch (error) {
      console.error("Error creating AI project:", error);
      res.status(500).json({ message: "Failed to create AI project" });
    }
  });

  app.post('/api/projects', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const projectData = insertProjectSchema.parse({
        ...req.body,
        ownerId: userId,
      });
      const project = await mongoStorage.createProject(projectData);
      
      // Create initial files based on template
      if (projectData.template === 'react') {
        // Create package.json
        await mongoStorage.createFile({
          projectId: project.id,
          name: "package.json",
          path: "/package.json",
          content: `{
  "name": "${project.name.toLowerCase().replace(/\\s+/g, '-')}",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-scripts": "5.0.1"
  },
  "scripts": {
    "start": "BROWSER=none react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject"
  }
}`,
          isFolder: false,
        });

        // Create README.md
        await mongoStorage.createFile({
          projectId: project.id,
          name: "README.md",
          path: "/README.md",
          content: `# ${project.name}

A React application created with CodeSpace IDE.

## Getting Started

1. Install dependencies:
\`\`\`bash
npm install
\`\`\`

2. Start the development server:
\`\`\`bash
npm start
\`\`\`

3. Open [http://localhost:3000](http://localhost:3000) to view it in the browser.
`,
          isFolder: false,
        });

        // Create .gitignore
        await mongoStorage.createFile({
          projectId: project.id,
          name: ".gitignore",
          path: "/.gitignore",
          content: `# Dependencies
/node_modules
/.pnp
.pnp.js

# Testing
/coverage

# Production
/build

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
`,
          isFolder: false,
        });

        // Create styles folder for structure (empty CSS files)
        await mongoStorage.createFile({
          projectId: project.id,
          name: "styles",
          path: "/styles",
          content: null,
          isFolder: true,
        });

        // Create empty App.css file for structure
        await mongoStorage.createFile({
          projectId: project.id,
          name: "App.css",
          path: "/styles/App.css",
          content: "",
          isFolder: false,
        });

        // Create App.jsx in ROOT (exactly like AI projects) - Using Tailwind CSS
        await mongoStorage.createFile({
          projectId: project.id,
          name: "App.jsx",
          path: "/App.jsx",
          content: `import React, { useState } from 'react';
import './styles/App.css';

function App() {
  const [count, setCount] = useState(0);
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-center">
      <div className="bg-white bg-opacity-95 p-10 rounded-3xl mx-5 shadow-2xl text-gray-800 max-w-2xl">
        <h1 className="text-4xl font-bold mb-4">Welcome to ${project.name}!</h1>
        <p className="text-lg mb-8">This is your React application built with CodeSpace IDE.</p>
        
        <div className="border-2 border-dashed border-blue-500 rounded-xl p-6 bg-blue-50 mb-8">
          <h2 className="text-2xl font-semibold mb-4">Counter Example</h2>
          <p className="text-2xl font-bold text-blue-600 mb-6">Count: {count}</p>
          
          <div className="flex gap-3 justify-center flex-wrap">
            <button 
              onClick={() => setCount(count + 1)}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors"
            >
              Increment
            </button>
            <button 
              onClick={() => setCount(count - 1)}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors"
            >
              Decrement  
            </button>
            <button 
              onClick={() => setCount(0)}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors"
            >
              Reset
            </button>
          </div>
        </div>
        
        <div className="text-gray-600">
          <p className="mb-2">
            Edit <code className="bg-gray-100 px-2 py-1 rounded text-sm">App.jsx</code> to customize this application.
          </p>
          <p>
            Your React app is ready to use! 🚀
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;`,
          isFolder: false,
        });

        // Create public folder and minimal index.html for CRA compatibility
        // Note: Updated preview logic prioritizes React components over HTML files
        await mongoStorage.createFile({
          projectId: project.id,
          name: "public",
          path: "/public",
          content: null,
          isFolder: true,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "index.html",
          path: "/public/index.html",
          content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="%PUBLIC_URL%/favicon.ico" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#000000" />
  <meta name="description" content="${project.name}" />
  <script src="https://cdn.tailwindcss.com"></script>
  <title>${project.name}</title>
</head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
</body>
</html>`,
          isFolder: false,
        });

        // No need to create styles folder for Tailwind CSS projects

      } else if (projectData.template === 'node') {
        // Node.js template
        await mongoStorage.createFile({
          projectId: project.id,
          name: "index.js",
          path: "/index.js",
          content: `const http = require('http');\nconst port = process.env.PORT || 3000;\n\nconst server = http.createServer((req, res) => {\n  res.writeHead(200, {'Content-Type': 'text/html'});\n  res.end('<h1>Hello World!</h1><p>Your Node.js server is running successfully.</p>');\n});\n\nserver.listen(port, () => {\n  console.log(\`Server running on port \${port}\`);\n});`,
          isFolder: false,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "package.json",
          path: "/package.json",
          content: `{\n  "name": "${project.name.toLowerCase().replace(/\\s+/g, '-')}",\n  "version": "1.0.0",\n  "description": "A simple Node.js application",\n  "main": "index.js",\n  "scripts": {\n    "start": "node index.js",\n    "dev": "nodemon index.js"\n  },\n  "keywords": [],\n  "author": "",\n  "license": "ISC",\n  "devDependencies": {\n    "nodemon": "^2.0.20"\n  }\n}`,
          isFolder: false,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "README.md",
          path: "/README.md",
          content: `# ${project.name}\n\nA simple Node.js application.\n\n## Getting Started\n\n1. Install dependencies:\n\`\`\`bash\nnpm install\n\`\`\`\n\n2. Run the application:\n\`\`\`bash\nnpm start\n\`\`\`\n\n3. For development with auto-reload:\n\`\`\`bash\nnpm run dev\n\`\`\`\n\nThe server will start on port 3000.`,
          isFolder: false,
        });
      } else if (projectData.template === 'python') {
        // Python template
        await mongoStorage.createFile({
          projectId: project.id,
          name: "main.py",
          path: "/main.py",
          content: `#!/usr/bin/env python3\n\ndef main():\n    print("Hello World!")\n    print("Your Python application is running successfully.")\n    \n    # Simple counter example\n    for count in range(1, 6):\n        print(f"Count: {count}")\n    \n    # Math calculation example\n    numbers = [1, 2, 3, 4, 5]\n    total = sum(numbers)\n    print(f"Sum of {numbers} = {total}")\n    \n    print("Program completed successfully!")\n\nif __name__ == "__main__":\n    main()`,
          isFolder: false,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "requirements.txt",
          path: "/requirements.txt",
          content: `# Add your Python dependencies here\n# Example:\n# requests==2.28.0\n# flask==2.2.0`,
          isFolder: false,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "README.md",
          path: "/README.md",
          content: `# ${project.name}\n\nA simple Python application.\n\n## Getting Started\n\n1. Install dependencies (if any):\n\`\`\`bash\npip install -r requirements.txt\n\`\`\`\n\n2. Run the application:\n\`\`\`bash\npython main.py\n\`\`\``,
          isFolder: false,
        });
      } else if (projectData.template === 'vanilla') {
        // Vanilla JavaScript template
        await mongoStorage.createFile({
          projectId: project.id,
          name: "index.html",
          path: "/index.html",
          content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>${project.name}</title>\n    <link rel="stylesheet" href="style.css">\n</head>\n<body>\n    <div class="container">\n        <h1>Hello World!</h1>\n        <p>Your Vanilla JavaScript project is ready!</p>\n        <button id="clickBtn">Click me: <span id="counter">0</span></button>\n    </div>\n    <script src="script.js"></script>\n</body>\n</html>`,
          isFolder: false,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "style.css",
          path: "/style.css",
          content: `body {\n    font-family: Arial, sans-serif;\n    margin: 0;\n    padding: 0;\n    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n    min-height: 100vh;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n}\n\n.container {\n    text-align: center;\n    background: white;\n    padding: 2rem;\n    border-radius: 10px;\n    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);\n}\n\nh1 {\n    color: #333;\n    margin-bottom: 1rem;\n}\n\np {\n    color: #666;\n    margin-bottom: 2rem;\n}\n\nbutton {\n    background: #007bff;\n    color: white;\n    border: none;\n    padding: 12px 24px;\n    border-radius: 5px;\n    cursor: pointer;\n    font-size: 16px;\n    transition: background-color 0.3s;\n}\n\nbutton:hover {\n    background: #0056b3;\n}`,
          isFolder: false,
        });

        await mongoStorage.createFile({
          projectId: project.id,
          name: "script.js",
          path: "/script.js",
          content: `let count = 0;\nconst button = document.getElementById('clickBtn');\nconst counter = document.getElementById('counter');\n\nbutton.addEventListener('click', () => {\n    count++;\n    counter.textContent = count;\n    console.log(\`Button clicked \${count} times\`);\n});\n\nconsole.log('Vanilla JavaScript project loaded successfully!');`,
          isFolder: false,
        });
      }

      res.json(project);
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ message: "Failed to create project" });
    }
  });

  app.get('/api/projects/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      // Check if user has access
      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      
      // Check if user is admin - admins can access any project
      const isUserAdmin = Boolean(req.user?.isAdmin);
      
      const hasAccess = projectOwnerId === userId || project.isPublic || isUserAdmin;
      if (!hasAccess) {
        const collaboration = await mongoStorage.getCollaboration(id, userId);
        if (!collaboration) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      res.json(project);
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  app.put('/api/projects/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      if (projectOwnerId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Handle null values in request body
      const sanitizedBody = {
        ...req.body,
        isPublic: req.body.isPublic === null ? false : req.body.isPublic
      };
      const updateData = insertProjectSchema.partial().parse(sanitizedBody);
      const updatedProject = await mongoStorage.updateProject(id, updateData);
      res.json(updatedProject);
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ message: "Failed to update project" });
    }
  });

  app.delete('/api/projects/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      if (projectOwnerId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await mongoStorage.deleteProject(id);
      res.json({ message: "Project deleted successfully" });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  // Enhanced file routes with filesystem sync
  app.get('/api/projects/:projectId/files', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { projectId } = req.params;
      const { sync } = req.query; // Optional sync parameter
      
      // Check project access
      const project = await mongoStorage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      
      // Check if user is admin - admins can access any project files
      const isUserAdmin = Boolean(req.user?.isAdmin);
      
      const hasAccess = projectOwnerId === userId || project.isPublic || isUserAdmin;
      if (!hasAccess) {
        const collaboration = await mongoStorage.getCollaboration(projectId, userId);
        if (!collaboration) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      // Only perform filesystem sync when explicitly requested to avoid duplicates
      if (sync === 'true') {
        try {
          const projectPath = path.join(process.cwd(), 'projects', projectId);
          await fileSystemSync.syncProjectFiles({
            projectId,
            projectPath,
            includeNodeModules: false, // Disable node_modules sync to reduce duplicates
            maxDepth: 5 // Reduce depth to avoid deep scanning
          });
          console.log(`Filesystem sync completed for project ${projectId}`);
        } catch (syncError) {
          console.warn(`Filesystem sync failed for project ${projectId}:`, syncError);
        }
      }

      // Get updated files list
      const files = await mongoStorage.getProjectFiles(projectId);
      res.json(files);
    } catch (error) {
      console.error("Error fetching files:", error);
      res.status(500).json({ message: "Failed to fetch files" });
    }
  });

  app.post('/api/projects/:projectId/files', isAuthenticated, async (req: any, res) => {
    try {
      const { projectId } = req.params;
      
      // Check project access (allows admins to bypass ownership)
      const access = await assertProjectWriteAccess(req, projectId);
      if (!access.ok) {
        return res.status(access.code || 403).json({ message: access.msg || "Access denied" });
      }

      const fileData = insertFileSchema.parse({
        ...req.body,
        projectId,
      });
      const file = await mongoStorage.createFile(fileData);
      res.json(file);
    } catch (error) {
      console.error("Error creating file:", error);
      res.status(500).json({ message: "Failed to create file" });
    }
  });

  app.put('/api/files/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // Check file access (includes admin bypass and project ownership)
      const access = await assertFileWriteAccess(req, id);
      if (!access.ok) {
        return res.status(access.code || 403).json({ message: access.msg || "Access denied" });
      }

      const updateData = insertFileSchema.partial().parse(req.body);
      const updatedFile = await mongoStorage.updateFile(id, updateData);
      res.json(updatedFile);
    } catch (error) {
      console.error("Error updating file:", error);
      res.status(500).json({ message: "Failed to update file" });
    }
  });

  // Simple endpoint to update file content by path
  app.put('/api/projects/:projectId/files/update', isAuthenticated, async (req: any, res) => {
    try {
      const { projectId } = req.params;
      const { path, content } = req.body;
      
      if (!path || content === undefined) {
        return res.status(400).json({ message: "Path and content are required" });
      }

      // Check project access (allows admins to bypass ownership)
      const access = await assertProjectWriteAccess(req, projectId);
      if (!access.ok) {
        return res.status(access.code || 403).json({ message: access.msg || "Access denied" });
      }

      // Get project files to find the file with matching path
      const files = await mongoStorage.getProjectFiles(projectId);
      const file = files.find(f => f.path === path);
      
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }

      // Validate the update data
      const updateData = insertFileSchema.partial().parse({ content });
      const updatedFile = await mongoStorage.updateFile(file.id, updateData);
      res.json(updatedFile);
    } catch (error) {
      console.error("Error updating file by path:", error);
      res.status(500).json({ message: "Failed to update file" });
    }
  });

  app.delete('/api/files/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // Check file access (includes admin bypass and project ownership)
      const access = await assertFileWriteAccess(req, id);
      if (!access.ok) {
        return res.status(access.code || 403).json({ message: access.msg || "Access denied" });
      }

      await mongoStorage.deleteFile(id);
      res.json({ message: "File deleted successfully" });
    } catch (error) {
      console.error("Error deleting file:", error);
      res.status(500).json({ message: "Failed to delete file" });
    }
  });

  // Rename file or folder
  app.put('/api/files/:id/rename', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { newName } = req.body;
      
      if (!newName || !newName.trim()) {
        return res.status(400).json({ message: "New name is required" });
      }

      // Check file access (includes admin bypass and project ownership)
      const access = await assertFileWriteAccess(req, id);
      if (!access.ok) {
        return res.status(access.code || 403).json({ message: access.msg || "Access denied" });
      }

      const file = await mongoStorage.getFile(id);
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }

      // Build new path
      const pathParts = file.path.split('/');
      pathParts[pathParts.length - 1] = newName.trim();
      const newPath = pathParts.join('/');

      // Check if a file with the new path already exists in the same project
      const allFiles = await mongoStorage.getProjectFiles(file.projectId.toString());
      const existingFile = allFiles.find((f: any) => f.path === newPath && f.id !== id);
      if (existingFile) {
        return res.status(409).json({ message: "A file or folder with this name already exists" });
      }

      // If it's a folder, we need to update all child files/folders too
      if (file.isFolder) {
        const childFiles = allFiles.filter((f: any) => 
          f.path.startsWith(file.path + '/') && f.id !== id
        );

        // Update all child files with new paths
        for (const childFile of childFiles) {
          const updatedChildPath = childFile.path.replace(file.path + '/', newPath + '/');
          await mongoStorage.updateFile(childFile.id || childFile._id?.toString(), { path: updatedChildPath });
        }
      }

      // Update the file itself
      const updatedFile = await mongoStorage.updateFile(id, { 
        name: newName.trim(), 
        path: newPath 
      });

      res.json({ 
        message: "File renamed successfully", 
        file: updatedFile 
      });
    } catch (error) {
      console.error("Error renaming file:", error);
      res.status(500).json({ message: "Failed to rename file" });
    }
  });

  // Fix React webpack projects by adding missing src files
  app.post('/api/projects/:id/fix-react', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // Check project access (allows admins to bypass ownership)
      const access = await assertProjectWriteAccess(req, id);
      if (!access.ok) {
        return res.status(access.code || 403).json({ message: access.msg || "Access denied" });
      }
      
      const project = await mongoStorage.getProject(id);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      // Create src folder if it doesn't exist
      try {
        await mongoStorage.createFile({
          projectId: id,
          name: "src",
          path: "/src",
          content: null,
          isFolder: true,
        });
      } catch (e) {
        // Folder might already exist, ignore error
      }

      // Create src/index.js for webpack entry point
      await mongoStorage.createFile({
        projectId: id,
        name: "index.js",
        path: "/src/index.js",
        content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './App.css';\n\nconst root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n\nconsole.log('React app loaded successfully!');`,
        isFolder: false,
      });

      // Create src/App.js 
      await mongoStorage.createFile({
        projectId: id,
        name: "App.js",
        path: "/src/App.js",
        content: `import React, { useState } from 'react';\n\nfunction App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <div className="App">\n      <header className="App-header">\n        <h1>Hello World!</h1>\n        <p>Welcome to your React app!</p>\n        <button onClick={() => setCount(count + 1)}>\n          Count: {count}\n        </button>\n        <p>You clicked {count} times</p>\n      </header>\n    </div>\n  );\n}\n\nexport default App;`,
        isFolder: false,
      });

      // Create src/App.css
      await mongoStorage.createFile({
        projectId: id,
        name: "App.css",
        path: "/src/App.css",
        content: `.App {\n  text-align: center;\n}\n\n.App-header {\n  background-color: #282c34;\n  padding: 20px;\n  color: white;\n  min-height: 100vh;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  font-size: calc(10px + 2vmin);\n}\n\nbutton {\n  padding: 10px 20px;\n  margin: 10px;\n  background: #61dafb;\n  color: #282c34;\n  border: none;\n  border-radius: 4px;\n  cursor: pointer;\n  font-size: 16px;\n}\n\nbutton:hover {\n  background: #21c0e8;\n}\n\np {\n  margin: 10px 0;\n}`,
        isFolder: false,
      });

      res.json({ message: "React project files created successfully" });
    } catch (error) {
      console.error("Error fixing React project:", error);
      res.status(500).json({ message: "Failed to fix React project" });
    }
  });

  // AI Assistant routes
  app.post('/api/ai/generate', isAuthenticated, async (req: any, res) => {
    try {
      const { prompt, language = 'javascript' } = req.body;
      
      if (!prompt) {
        return res.status(400).json({ message: "Prompt is required" });
      }

      const code = await generateCode(prompt, language);
      res.json({ code });
    } catch (error) {
      console.error("Error generating code:", error);
      res.status(500).json({ message: "Failed to generate code" });
    }
  });

  app.post('/api/ai/explain', isAuthenticated, async (req: any, res) => {
    try {
      const { code, language = 'javascript' } = req.body;
      
      if (!code) {
        return res.status(400).json({ message: "Code is required" });
      }

      const explanation = await explainCode(code, language);
      res.json({ explanation });
    } catch (error) {
      console.error("Error explaining code:", error);
      res.status(500).json({ message: "Failed to explain code" });
    }
  });

  app.post('/api/ai/debug', isAuthenticated, async (req: any, res) => {
    try {
      const { code, language = 'javascript', error: errorMsg } = req.body;
      
      if (!code) {
        return res.status(400).json({ message: "Code is required" });
      }

      const suggestions = await debugCode(code, language, errorMsg);
      res.json({ suggestions });
    } catch (error) {
      console.error("Error debugging code:", error);
      res.status(500).json({ message: "Failed to debug code" });
    }
  });

  // Fix missing index.html in React projects
  app.post('/api/projects/:projectId/fix-react', isAuthenticated, async (req: any, res) => {
    try {
      const { projectId } = req.params;
      const userId = req.user._id?.toString() || req.user.id;
      
      // Check project access
      const project = await mongoStorage.getProject(projectId);
      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      if (!project || projectOwnerId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Check if public folder and index.html already exist
      const existingFiles = await mongoStorage.getProjectFiles(projectId);
      const hasPublicFolder = existingFiles.some(f => f.path === '/public' && f.isFolder);
      const hasIndexHtml = existingFiles.some(f => f.path === '/public/index.html');
      
      const createdFiles = [];
      
      // Create public folder if it doesn't exist
      if (!hasPublicFolder) {
        const publicFolder = await mongoStorage.createFile({
          projectId,
          name: 'public',
          path: '/public',
          content: null,
          isFolder: true,
        });
        createdFiles.push(publicFolder);
      }
      
      // Create index.html if it doesn't exist
      if (!hasIndexHtml) {
        const indexHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="%PUBLIC_URL%/favicon.ico" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#000000" />
  <meta name="description" content="${project.name || 'React Application'}" />
  <title>${project.name || 'React App'}</title>
</head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
</body>
</html>`;
        
        const indexHtmlFile = await mongoStorage.createFile({
          projectId,
          name: 'index.html',
          path: '/public/index.html',
          content: indexHtmlContent,
          isFolder: false,
        });
        createdFiles.push(indexHtmlFile);
      }
      
      res.json({ 
        message: `Fixed React project - added ${createdFiles.length} missing files`,
        files: createdFiles
      });
    } catch (error) {
      console.error('Error fixing React project:', error);
      res.status(500).json({ message: 'Failed to fix React project' });
    }
  });

  // Apply AI generated code to project
  app.post('/api/ai/apply-code', isAuthenticated, async (req: any, res) => {
    try {
      const { projectId, code } = req.body;
      
      if (!projectId || !code) {
        return res.status(400).json({ message: 'Project ID and code are required' });
      }

      // Parse the generated code into files
      const parsedProject = await parseAndCreateProjectFiles(code, 'AI Generated Code');
      
      // Create folders first
      const foldersToCreate = new Set<string>();
      for (const file of parsedProject.files) {
        const pathParts = file.path.split('/').filter(part => part);
        let currentPath = '';
        for (let i = 0; i < pathParts.length - 1; i++) {
          currentPath += '/' + pathParts[i];
          foldersToCreate.add(currentPath);
        }
      }

      // Create folders
      for (const folderPath of Array.from(foldersToCreate).sort()) {
        try {
          const folderName = folderPath.split('/').pop() || '';
          await mongoStorage.createFile({
            projectId,
            name: folderName,
            path: folderPath,
            content: null,
            isFolder: true,
          });
        } catch (folderError) {
          // Folder might already exist, continue
        }
      }

      // Create or update files (avoiding duplicates)
      const createdFiles = [];
      const existingFiles = await mongoStorage.getProjectFiles(projectId);
      const processedPaths = new Set<string>();
      
      for (const file of parsedProject.files) {
        try {
          // Skip if we already processed this path
          if (processedPaths.has(file.path)) {
            console.log(`Skipping duplicate file: ${file.path}`);
            continue;
          }
          processedPaths.add(file.path);
          
          const existingFile = existingFiles.find(f => f.path === file.path);
          
          if (existingFile) {
            // Update existing file
            const updatedFile = await mongoStorage.updateFile(existingFile.id, { content: file.content });
            createdFiles.push(updatedFile);
          } else {
            // Create new file
            const createdFile = await mongoStorage.createFile({
              projectId,
              name: file.name,
              path: file.path,
              content: file.content,
              isFolder: false,
            });
            createdFiles.push(createdFile);
          }
        } catch (fileError) {
          console.error(`Error creating/updating file ${file.name}:`, fileError);
        }
      }

      res.json({ 
        files: createdFiles,
        message: `Applied AI code - ${createdFiles.length} files created/updated`
      });
    } catch (error) {
      console.error('Error applying AI code:', error);
      res.status(500).json({ message: 'Failed to apply AI code' });
    }
  });

  app.post('/api/ai/chat', isAuthenticated, async (req: any, res) => {
    const { projectId, message } = req.body;
    
    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    try {
      let context = '';
      
      // If asking about specific files or UI improvements, get project context
      if (projectId && (message.toLowerCase().includes('file') || message.toLowerCase().includes('ui') || message.toLowerCase().includes('improve') || message.toLowerCase().includes('app.jsx'))) {
        try {
          const project = await mongoStorage.getProject(projectId);
          const files = await mongoStorage.getProjectFiles(projectId);
          
          // Find App.jsx or main component file
          const appFile = files.find(f => f.name.toLowerCase().includes('app.jsx') || f.name.toLowerCase().includes('app.js'));
          
          if (appFile && appFile.content) {
            context = `Current project: ${project?.name}\nCurrent App.jsx code:\n${appFile.content.substring(0, 2000)}`;
          }
        } catch (err) {
          console.log('Could not fetch project context:', err);
        }
      }
      
      // Use the real AI chat function with context
      const aiResponse = await chatWithAI(message, context);

      res.json({ 
        response: aiResponse
      });
    } catch (error) {
      console.error('Error in AI chat:', error);
      res.json({ 
        response: "I'm here to help with your coding questions! You can ask me to explain code, debug issues, generate new code snippets, or ask general programming questions. What specific task would you like assistance with?"
      });
    }
  });

  // Project sharing with users
  app.post('/api/projects/:id/share', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { userEmail, role } = req.body; // role: 'editor' or 'viewer'
      const userId = req.user.id;
      
      if (!userEmail) {
        return res.status(400).json({ message: "User email is required" });
      }
      
      const project = await mongoStorage.getProject(id);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if current user has permission to share
      if (project.ownerId.toString() !== userId) {
        const collaboration = await mongoStorage.getCollaboration(id, userId);
        if (!collaboration || (collaboration.role !== 'owner' && collaboration.role !== 'editor')) {
          return res.status(403).json({ message: "You don't have permission to share this project" });
        }
      }
      
      // Find user to share with
      const targetUser = await mongoStorage.getUserByEmail(userEmail);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found with this email" });
      }
      
      // Share project with user
      const success = await mongoStorage.shareProject(id, targetUser._id?.toString() || targetUser.id!, role || 'viewer');
      
      if (success) {
        res.json({ 
          message: `Project shared with ${userEmail} as ${role || 'viewer'}`,
          sharedWith: {
            email: userEmail,
            role: role || 'viewer'
          }
        });
      } else {
        res.status(500).json({ message: "Failed to share project" });
      }
    } catch (error) {
      console.error("Error sharing project:", error);
      res.status(500).json({ message: "Failed to share project" });
    }
  });

  // Make project public
  app.post('/api/projects/:id/make-public', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        console.log("🚫 Project not found:", id);
        return res.status(404).json({ message: "Project not found" });
      }
      
      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      
      console.log("🔍 Share debug - User ID:", userId, "Project Owner ID:", projectOwnerId);
      
      if (projectOwnerId !== userId) {
        console.log("🚫 Access denied for user:", userId, "project owner:", projectOwnerId);
        return res.status(403).json({ message: "Access denied" });
      }

      await mongoStorage.updateProject(id, { isPublic: true });
      
      // Generate share URL - Use deployment URL if available, fallback to localhost for development
      let baseUrl = 'localhost:5000';
      
      // Check for various deployment environment variables
      if (process.env.RENDER_EXTERNAL_URL) {
        // Render deployment
        baseUrl = process.env.RENDER_EXTERNAL_URL.replace('https://', '').replace('http://', '');
      } else if (process.env.RAILWAY_STATIC_URL) {
        // Railway deployment
        baseUrl = process.env.RAILWAY_STATIC_URL.replace('https://', '').replace('http://', '');
      } else if (process.env.VERCEL_URL) {
        // Vercel deployment
        baseUrl = process.env.VERCEL_URL;
      } else if (process.env.NETLIFY_URL) {
        // Netlify deployment
        baseUrl = process.env.NETLIFY_URL.replace('https://', '').replace('http://', '');
      } else if (process.env.HEROKU_APP_NAME) {
        // Heroku deployment
        baseUrl = `${process.env.HEROKU_APP_NAME}.herokuapp.com`;
      } else if (process.env.REPLIT_DOMAINS) {
        // Replit deployment
        baseUrl = process.env.REPLIT_DOMAINS.split(',')[0];
      } else if (process.env.DEPLOYMENT_URL) {
        // Custom deployment URL
        baseUrl = process.env.DEPLOYMENT_URL.replace('https://', '').replace('http://', '');
      }
      
      const shareUrl = `https://${baseUrl}/shared/${id}`;
      console.log(`Generated share URL: ${shareUrl}`);
      
      res.json({ shareUrl });
    } catch (error) {
      console.error("Error making project public:", error);
      res.status(500).json({ message: "Failed to make project public" });
    }
  });

  // Remove project access
  app.delete('/api/projects/:id/share/:userId', isAuthenticated, async (req: any, res) => {
    try {
      const { id, userId: targetUserId } = req.params;
      const userId = req.user.id;
      
      const project = await mongoStorage.getProject(id);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if current user has permission to remove access
      if (project.ownerId.toString() !== userId) {
        const collaboration = await mongoStorage.getCollaboration(id, userId);
        if (!collaboration || collaboration.role !== 'owner') {
          return res.status(403).json({ message: "Only project owners can remove access" });
        }
      }
      
      const success = await mongoStorage.removeProjectAccess(id, targetUserId);
      
      if (success) {
        res.json({ message: "Access removed successfully" });
      } else {
        res.status(500).json({ message: "Failed to remove access" });
      }
    } catch (error) {
      console.error("Error removing project access:", error);
      res.status(500).json({ message: "Failed to remove access" });
    }
  });

  // Get shared projects
  app.get('/api/projects/shared', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const sharedProjects = await mongoStorage.getSharedProjects(userId);
      res.json(sharedProjects);
    } catch (error) {
      console.error("Error fetching shared projects:", error);
      res.status(500).json({ message: "Failed to fetch shared projects" });
    }
  });

  // Public project access
  app.get('/api/shared/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project || !project.isPublic) {
        return res.status(404).json({ message: "Project not found or not public" });
      }

      const files = await mongoStorage.getProjectFiles(id);
      res.json({ project, files });
    } catch (error) {
      console.error("Error fetching shared project:", error);
      res.status(500).json({ message: "Failed to fetch shared project" });
    }
  });

  // Project preview generation - return HTML content for iframe
  app.get('/api/projects/:id/preview-html', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        const notFoundHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Project Not Found</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      margin: 0; 
      padding: 20px;
      background: #f8f9fa;
      color: #6c757d;
      line-height: 1.6;
      text-align: center;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border: 1px solid #e9ecef;
      border-radius: 8px;
      padding: 48px 32px;
      max-width: 500px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .icon {
      font-size: 64px;
      margin-bottom: 24px;
    }
    .title {
      color: #495057;
      margin: 0 0 16px 0;
      font-size: 24px;
      font-weight: 600;
    }
    .message {
      margin-bottom: 24px;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">📁</div>
    <h1 class="title">Project Not Found</h1>
    <p class="message">The project you're looking for doesn't exist or may have been deleted.</p>
    <p class="message">Please check the project ID and try again.</p>
  </div>
</body>
</html>`;
        return res.status(404).send(notFoundHtml);
      }

      const files = await mongoStorage.getProjectFiles(id);
      
      // Check if this is a React project first (prioritize React over HTML)
      const hasReactComponents = files.some((f: any) => 
        f.name === 'App.js' || f.name === 'App.jsx' || 
        f.path === '/App.js' || f.path === '/App.jsx' ||
        f.name.endsWith('.jsx') || f.name.endsWith('.tsx')
      );
      
      // Check if this is an HTML project (vanilla JS/HTML) - but only if NOT React
      const htmlFile = files.find((f: any) => f.name === 'index.html' && f.path === '/index.html'); // Only root index.html
      
      if (htmlFile && !hasReactComponents) {
        // Handle vanilla HTML/CSS/JS projects
        let htmlContent = htmlFile.content || '';
        
        // Find CSS and JS files
        const cssFiles = files.filter((f: any) => f.name.endsWith('.css'));
        const jsFiles = files.filter((f: any) => f.name.endsWith('.js') && f.name !== 'package.json');
        
        // Add improved error handling script with sourceURL parsing
        const errorHandlingScript = `
        <script>
          function extractFileAndLineFromStack(error) {
            if (!error || !error.stack) return { fileName: 'Unknown', lineNumber: 'Unknown' };
            
            const stackLines = error.stack.split('\\n');
            for (const line of stackLines) {
              // Chrome/Firefox: "at functionName (filename:line:col)" or "at filename:line:col"
              const chromeMatch = line.match(/^(?:\\s*at\\s+.*\\()?(.+?):(\\d+):(\\d+)\\)?$/);
              if (chromeMatch) {
                const fileName = chromeMatch[1];
                const lineNumber = chromeMatch[2];
                
                // Check if this is one of our project files (contains project path or is not a system file)
                if (fileName && !fileName.startsWith('http') && !fileName.includes('node_modules') && 
                    (fileName.includes('/') || fileName.endsWith('.js'))) {
                  return {
                    fileName: decodeURI(fileName),
                    lineNumber: lineNumber
                  };
                }
              }
              
              // Safari: "@ filename:line:col"
              const safariMatch = line.match(/^\\s*@\\s*(.+?):(\\d+):(\\d+)$/);
              if (safariMatch) {
                const fileName = safariMatch[1];
                const lineNumber = safariMatch[2];
                
                if (fileName && !fileName.startsWith('http') && !fileName.includes('node_modules') &&
                    (fileName.includes('/') || fileName.endsWith('.js'))) {
                  return {
                    fileName: decodeURI(fileName),
                    lineNumber: lineNumber
                  };
                }
              }
              
              // Fallback: look for blob: URLs with line numbers
              const blobMatch = line.match(/blob:[^:]+:(\\d+):(\\d+)/);
              if (blobMatch) {
                return {
                  fileName: 'JavaScript File',
                  lineNumber: blobMatch[1]
                };
              }
            }
            
            return { fileName: 'Unknown', lineNumber: 'Unknown' };
          }
          
          window.addEventListener('error', function(e) {
            let fileName = e.filename || 'Unknown';
            let lineNumber = e.lineno || 'Unknown';
            
            // If error object is available, try to extract better info from stack
            if (e.error) {
              const stackInfo = extractFileAndLineFromStack(e.error);
              if (stackInfo.fileName !== 'Unknown') {
                fileName = stackInfo.fileName;
                lineNumber = stackInfo.lineNumber;
              }
            }
            
            const errorContainer = document.createElement('div');
            errorContainer.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: #fdf2f2; color: #e74c3c; border-bottom: 2px solid #fecaca; padding: 16px; font-family: monospace; z-index: 10000; max-height: 200px; overflow-y: auto;';
            errorContainer.innerHTML = '<strong>JavaScript Error:</strong><br>' + 
              'File: ' + fileName + '<br>' +
              'Line: ' + lineNumber + '<br>' +
              'Message: ' + (e.message || 'Unknown error');
            document.body.insertBefore(errorContainer, document.body.firstChild);
          });
          
          window.addEventListener('unhandledrejection', function(e) {
            let fileName = 'Unknown';
            let lineNumber = 'Unknown';
            
            // Try to extract file info from rejection reason if it's an error
            if (e.reason && e.reason.stack) {
              const stackInfo = extractFileAndLineFromStack(e.reason);
              fileName = stackInfo.fileName;
              lineNumber = stackInfo.lineNumber;
            }
            
            const errorContainer = document.createElement('div');
            errorContainer.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: #fdf2f2; color: #e74c3c; border-bottom: 2px solid #fecaca; padding: 16px; font-family: monospace; z-index: 10000; max-height: 200px; overflow-y: auto;';
            errorContainer.innerHTML = '<strong>Promise Rejection:</strong><br>' + 
              'File: ' + fileName + '<br>' +
              'Line: ' + lineNumber + '<br>' +
              'Reason: ' + (e.reason || 'Unknown error');
            document.body.insertBefore(errorContainer, document.body.firstChild);
          });
        </script>`;
        
        // Inject error handling script first
        if (htmlContent.includes('<head>')) {
          htmlContent = htmlContent.replace('<head>', '<head>' + errorHandlingScript);
        } else if (htmlContent.includes('</head>')) {
          htmlContent = htmlContent.replace('</head>', errorHandlingScript + '</head>');
        } else {
          htmlContent = '<head>' + errorHandlingScript + '</head>' + htmlContent;
        }
        
        // Remove existing script src references to prevent external JS file requests
        const jsFileNames = jsFiles.map(jsFile => jsFile.name);
        jsFileNames.forEach(fileName => {
          // Remove script tags that reference this file
          const scriptSrcRegex = new RegExp(`<script[^>]*src\\s*=\\s*['"]\\.?/?${fileName.replace('.', '\\.')}['"][^>]*>\\s*</script>`, 'gi');
          htmlContent = htmlContent.replace(scriptSrcRegex, '');
          
          // Also remove self-closing script tags
          const scriptSelfClosingRegex = new RegExp(`<script[^>]*src\\s*=\\s*['"]\\.?/?${fileName.replace('.', '\\.')}['"][^>]*/>`, 'gi');
          htmlContent = htmlContent.replace(scriptSelfClosingRegex, '');
        });
        
        // Remove existing link rel="stylesheet" references to prevent external CSS file requests
        const cssFileNames = cssFiles.map(cssFile => cssFile.name);
        cssFileNames.forEach(fileName => {
          const linkRegex = new RegExp(`<link[^>]*href\\s*=\\s*['"]\\.?/?${fileName.replace('.', '\\.')}['"][^>]*>`, 'gi');
          htmlContent = htmlContent.replace(linkRegex, '');
        });
        
        // Inject CSS and JS into HTML
        cssFiles.forEach(cssFile => {
          const cssTag = `<style>${cssFile.content || ''}</style>`;
          if (htmlContent.includes('</head>')) {
            htmlContent = htmlContent.replace('</head>', `${cssTag}\n</head>`);
          } else {
            htmlContent = `<head>${cssTag}</head>${htmlContent}`;
          }
        });
        
        // Inject JavaScript files using Blob URLs for accurate line numbers and file names
        jsFiles.forEach(jsFile => {
          const jsContent = jsFile.content || '';
          // Use full file path for unique identification, encode for sourceURL
          const filePath = jsFile.path || jsFile.name;
          const jsContentWithSource = jsContent + '\n//# sourceURL=' + encodeURI(filePath);
          
          // Create the script that loads JS via Blob URL for native browser error reporting
          const scriptTag = `
          <script>
            (function() {
              const jsContent = ${JSON.stringify(jsContentWithSource)};
              const blob = new Blob([jsContent], { type: 'application/javascript' });
              const scriptUrl = URL.createObjectURL(blob);
              const scriptElement = document.createElement('script');
              scriptElement.src = scriptUrl;
              scriptElement.async = false; // Preserve execution order
              scriptElement.onerror = function() {
                console.error('Failed to load script: ${filePath}');
              };
              document.head.appendChild(scriptElement);
              // Clean up the blob URL after loading to prevent memory leaks
              scriptElement.onload = function() {
                URL.revokeObjectURL(scriptUrl);
              };
            })();
          </script>`;
          
          if (htmlContent.includes('</body>')) {
            htmlContent = htmlContent.replace('</body>', `${scriptTag}\n</body>`);
          } else {
            htmlContent = `${htmlContent}${scriptTag}`;
          }
        });
        
        return res.send(htmlContent);
      }
      
      // Check if this is a Node.js backend project (has package.json but no frontend files)
      const packageJsonFile = files.find((f: any) => f.name === 'package.json');

      if (packageJsonFile && !hasReactComponents) {
        // This is a Node.js backend project - show a simple preview
        const previewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project.name} - Node.js Project</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      margin: 0; 
      padding: 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      background: rgba(255,255,255,0.1);
      padding: 40px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
    }
    h1 { margin: 0 0 20px 0; font-size: 2.5em; }
    p { margin: 10px 0; font-size: 1.2em; opacity: 0.9; }
    .code { 
      background: rgba(0,0,0,0.2);
      padding: 15px;
      border-radius: 10px;
      margin: 20px 0;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 1em;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 ${project.name}</h1>
    <p>Node.js project is running successfully!</p>
    <div class="code">npm start</div>
    <p>This is a backend Node.js project. Check the terminal for server logs and API endpoints.</p>
  </div>
</body>
</html>`;
        return res.send(previewHtml);
      }
      
      // Handle React projects
      // Find App.js/App.jsx files (in root, src folder, or any folder)
      const appJsFile = files.find((f: any) => 
        f.name === 'App.js' || f.name === 'App.jsx' || 
        f.path.endsWith('/App.js') || f.path.endsWith('/App.jsx') ||
        f.path.endsWith('/src/App.js') || f.path.endsWith('/src/App.jsx')
      );
      
      // Find CSS files from styles folder and root - but exclude any IDE/system CSS
      const cssFiles = files.filter((f: any) => 
        (f.name.endsWith('.css') || f.path.includes('styles/')) &&
        !f.path.includes('client/src') && // Exclude main IDE CSS
        !f.name.includes('index.css') && // Exclude main index.css
        !f.path.includes('node_modules') // Exclude node modules
      );
      const appCssFile = cssFiles.find((f: any) => 
        f.name === 'App.css' || f.path.includes('App.css')
      ) || cssFiles[0]; // Use first CSS file if App.css not found
      
      // Find all component files from components folder and root
      const componentFiles = files.filter((f: any) => 
        (f.name.endsWith('.jsx') || f.name.endsWith('.js')) && 
        !f.name.includes('App.') && 
        f.name !== 'package.json' &&
        !f.name.includes('package-lock')
      );
      
      if (!appJsFile) {
        return res.status(400).send('<h1>App.js or App.jsx file not found</h1>');
      }

      // Clean all component files - improved to handle React modules properly
      const cleanComponent = (content: string, isMainApp = false) => {
        if (!content) return '';
        
        let cleanedContent = content
          .split('\n')
          .filter(line => {
            const trimmed = line.trim();
            // Remove all import and export statements
            return !trimmed.startsWith('import ') && 
                   !trimmed.startsWith('export default') &&
                   !trimmed.startsWith('export {') &&
                   !trimmed.startsWith('export ') &&
                   !trimmed.includes('export default');
          })
          .join('\n')
          .replace(/""([^"]*)""/g, '"$1"')
          .replace(/alert\(""([^"]*)""(?:\)|;)/g, 'alert("$1")')
          .trim();
        
        // Handle export default function syntax
        cleanedContent = cleanedContent.replace(/export\s+default\s+function\s+(\w+)/g, 'function $1');
        cleanedContent = cleanedContent.replace(/export\s+default\s+(\w+)/g, '');
        
        // Only inject React hooks for the main App component to avoid duplication
        if (isMainApp) {
          const reactHooks = `const React = window.React;
const { useState, useEffect, useMemo, useRef, useReducer, useCallback, useContext, useLayoutEffect, useImperativeHandle, useTransition, useDeferredValue } = React;

`;
          return reactHooks + cleanedContent;
        }
        
        return cleanedContent;
      };

      // Clean the main App component with React hooks
      let jsCode = cleanComponent(appJsFile.content || '', true);
      
      // Clean all additional components without React hooks duplication
      const uniqueComponents = new Map();
      componentFiles.forEach(file => {
        const componentName = file.name.replace(/\.(jsx?|tsx?)$/, '');
        if (!uniqueComponents.has(componentName)) {
          uniqueComponents.set(componentName, cleanComponent(file.content || '', false));
        }
      });
      let additionalComponents = Array.from(uniqueComponents.values()).join('\n\n');

      // Generate preview HTML with React code and better error handling
      const previewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project.name} - Live Preview</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      margin: 0; 
      padding: 0; 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; 
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #root {
      width: 100%;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .preview-error { 
      color: #e74c3c; 
      padding: 20px; 
      background: #fdf2f2; 
      border: 1px solid #fecaca; 
      border-radius: 8px; 
      margin: 20px; 
    }
    .preview-loading { 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      height: 100vh; 
      color: #666; 
    }
  </style>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    /* Reset and default styles for React preview */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      margin: 0; 
      padding: 0; 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background-color: #ffffff;
      color: #000000;
    }
    #root {
      min-height: 100vh;
      width: 100%;
    }
    
    /* Project-specific CSS files */
    ${cssFiles.map(file => {
      if (!file.content) return '';
      // Clean CSS to avoid conflicts with IDE styles
      let cleanCSS = file.content
        .replace(/--ide-[^:;{}]+:[^;{}]+;?/g, '') // Remove IDE-specific CSS variables
        .replace(/hsl\(220\s+13%\s+9%\)/g, '#ffffff') // Replace dark IDE backgrounds with white
        .replace(/var\(--ide-[^)]+\)/g, '#ffffff'); // Replace IDE variables with white
      return cleanCSS;
    }).join('\n\n')}
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;
    
    // Enhanced error handling for React components with cross-browser stack parsing
    function extractFileAndLineFromStack(error) {
      if (!error || !error.stack) return { fileName: 'Unknown', lineNumber: 'Unknown' };
      
      const stackLines = error.stack.split('\\n');
      for (const line of stackLines) {
        // Chrome/Firefox: "at functionName (filename:line:col)" or "at filename:line:col"
        const chromeMatch = line.match(/^(?:\\s*at\\s+.*\\()?(.+?):(\\d+):(\\d+)\\)?$/);
        if (chromeMatch) {
          const fileName = chromeMatch[1];
          const lineNumber = chromeMatch[2];
          
          // Check if this is one of our project files
          if (fileName && !fileName.startsWith('http') && !fileName.includes('node_modules') && 
              (fileName.includes('/') || fileName.endsWith('.js') || fileName.endsWith('.jsx'))) {
            return {
              fileName: decodeURI(fileName),
              lineNumber: lineNumber
            };
          }
        }
        
        // Safari: "@ filename:line:col"
        const safariMatch = line.match(/^\\s*@\\s*(.+?):(\\d+):(\\d+)$/);
        if (safariMatch) {
          const fileName = safariMatch[1];
          const lineNumber = safariMatch[2];
          
          if (fileName && !fileName.startsWith('http') && !fileName.includes('node_modules') &&
              (fileName.includes('/') || fileName.endsWith('.js') || fileName.endsWith('.jsx'))) {
            return {
              fileName: decodeURI(fileName),
              lineNumber: lineNumber
            };
          }
        }
        
        // Fallback: look for blob: URLs with line numbers
        const blobMatch = line.match(/blob:[^:]+:(\\d+):(\\d+)/);
        if (blobMatch) {
          return {
            fileName: 'React Component',
            lineNumber: blobMatch[1]
          };
        }
      }
      
      return { fileName: 'Unknown', lineNumber: 'Unknown' };
    }
    
    window.addEventListener('error', function(e) {
      if (document.getElementById('root')) {
        let fileName = e.filename || 'Unknown';
        let lineNumber = e.lineno || 'Unknown';
        
        // If error object is available, try to extract better info from stack
        if (e.error) {
          const stackInfo = extractFileAndLineFromStack(e.error);
          if (stackInfo.fileName !== 'Unknown') {
            fileName = stackInfo.fileName;
            lineNumber = stackInfo.lineNumber;
          }
        }
        
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement('div', {
          style: { 
            padding: '24px', 
            background: '#fdf2f2', 
            color: '#e74c3c', 
            border: '2px solid #fecaca',
            borderRadius: '8px',
            margin: '20px',
            fontFamily: 'system-ui, sans-serif'
          }
        }, [
          React.createElement('h3', {key: 'title', style: {marginTop: 0, fontSize: '20px'}}, '❌ React Component Error'),
          React.createElement('div', {key: 'details', style: {marginBottom: '16px'}}, [
            React.createElement('strong', {key: 'label'}, 'Error: '),
            React.createElement('span', {key: 'msg'}, e.message || 'Unknown error')
          ]),
          fileName !== 'Unknown' ? React.createElement('div', {key: 'file', style: {marginBottom: '8px', fontSize: '14px'}}, [
            React.createElement('strong', {key: 'flabel'}, 'File: '),
            React.createElement('code', {key: 'fname'}, fileName)
          ]) : null,
          lineNumber !== 'Unknown' ? React.createElement('div', {key: 'line', style: {marginBottom: '16px', fontSize: '14px'}}, [
            React.createElement('strong', {key: 'llabel'}, 'Line: '),
            React.createElement('code', {key: 'lnum'}, lineNumber)
          ]) : null,
          React.createElement('div', {key: 'help', style: {padding: '12px', background: '#e7f3ff', border: '1px solid #0066cc', borderRadius: '4px', fontSize: '14px', color: '#0066cc'}}, [
            React.createElement('strong', {key: 'htitle'}, '💡 Tips: '),
            React.createElement('br', {key: 'br1'}),
            '• Check your component syntax',
            React.createElement('br', {key: 'br2'}),
            '• Look for missing imports or typos',
            React.createElement('br', {key: 'br3'}),
            '• Verify prop names and types'
          ])
        ]));
      }
    });
    
    window.addEventListener('unhandledrejection', function(e) {
      if (document.getElementById('root')) {
        let fileName = 'Unknown';
        let lineNumber = 'Unknown';
        
        // Try to extract file info from rejection reason if it's an error
        if (e.reason && e.reason.stack) {
          const stackInfo = extractFileAndLineFromStack(e.reason);
          fileName = stackInfo.fileName;
          lineNumber = stackInfo.lineNumber;
        }
        
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement('div', {
          style: { 
            padding: '24px', 
            background: '#fdf2f2', 
            color: '#e74c3c', 
            border: '2px solid #fecaca',
            borderRadius: '8px',
            margin: '20px',
            fontFamily: 'system-ui, sans-serif'
          }
        }, [
          React.createElement('h3', {key: 'title', style: {marginTop: 0, fontSize: '20px'}}, '❌ Promise Rejection'),
          React.createElement('div', {key: 'details', style: {marginBottom: '16px'}}, [
            React.createElement('strong', {key: 'label'}, 'Reason: '),
            React.createElement('span', {key: 'reason'}, String(e.reason || 'Unknown error'))
          ]),
          fileName !== 'Unknown' ? React.createElement('div', {key: 'file', style: {marginBottom: '8px', fontSize: '14px'}}, [
            React.createElement('strong', {key: 'flabel'}, 'File: '),
            React.createElement('code', {key: 'fname'}, fileName)
          ]) : null,
          lineNumber !== 'Unknown' ? React.createElement('div', {key: 'line', style: {marginBottom: '16px', fontSize: '14px'}}, [
            React.createElement('strong', {key: 'llabel'}, 'Line: '),
            React.createElement('code', {key: 'lnum'}, lineNumber)
          ]) : null
        ]));
      }
    });
    
    try {
      // All additional components first
      ${additionalComponents}
      
      // Main App component last
      ${jsCode}
      
      // Render the app
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(App));
    } catch (error) {
      console.error('Preview Error:', error);
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement('div', {
        style: { 
          padding: '24px', 
          background: '#fdf2f2', 
          color: '#e74c3c', 
          border: '2px solid #fecaca',
          borderRadius: '8px',
          margin: '20px',
          fontFamily: 'system-ui, sans-serif'
        }
      }, [
        React.createElement('h3', {key: 'title', style: {marginTop: 0, fontSize: '20px'}}, '❌ React Render Error'),
        React.createElement('div', {key: 'message', style: {marginBottom: '16px'}}, 'There was an error rendering this React component.'),
        React.createElement('div', {key: 'error-details', style: {background: '#f8f9fa', border: '1px solid #e9ecef', borderRadius: '4px', padding: '12px', fontSize: '12px', fontFamily: 'monospace', overflow: 'auto', color: '#6c757d'}}, error.toString()),
        React.createElement('div', {key: 'help', style: {marginTop: '16px', padding: '12px', background: '#e7f3ff', border: '1px solid #0066cc', borderRadius: '4px', fontSize: '14px', color: '#0066cc'}}, [
          React.createElement('strong', {key: 'htitle'}, '💡 Common fixes: '),
          React.createElement('br', {key: 'br1'}),
          '• Check for syntax errors in your component',
          React.createElement('br', {key: 'br2'}),
          '• Verify that all props are properly defined',
          React.createElement('br', {key: 'br3'}),
          '• Make sure you export your App component'
        ])
      ]));
    }
  </script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(previewHtml);
      
    } catch (error) {
      console.error("Error generating preview:", error);
      
      // Create a detailed error page instead of generic message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorStack = error instanceof Error ? error.stack : '';
      
      const errorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Preview Error</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      margin: 0; 
      padding: 20px;
      background: #fdf2f2;
      color: #e74c3c;
      line-height: 1.6;
    }
    .error-container {
      background: white;
      border: 2px solid #fecaca;
      border-radius: 8px;
      padding: 24px;
      max-width: 800px;
      margin: 20px auto;
    }
    .error-title {
      color: #dc2626;
      margin-top: 0;
      font-size: 24px;
      font-weight: bold;
    }
    .error-message {
      background: #fef2f2;
      border-left: 4px solid #ef4444;
      padding: 12px 16px;
      margin: 16px 0;
      border-radius: 4px;
    }
    .error-stack {
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 4px;
      padding: 12px;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      color: #6c757d;
    }
    .help-text {
      margin-top: 20px;
      padding: 12px;
      background: #e7f3ff;
      border-left: 4px solid #0066cc;
      border-radius: 4px;
      color: #0066cc;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <h1 class="error-title">❌ Preview Generation Failed</h1>
    <p>There was an error while generating the preview for this project.</p>
    
    <div class="error-message">
      <strong>Error:</strong> ${errorMessage}
    </div>
    
    ${errorStack ? `
    <details>
      <summary style="cursor: pointer; margin: 16px 0 8px 0; font-weight: bold;">Show Technical Details</summary>
      <div class="error-stack">${errorStack}</div>
    </details>
    ` : ''}
    
    <div class="help-text">
      <strong>💡 Possible solutions:</strong><br>
      • Check if your code has syntax errors<br>
      • Ensure all required files are present<br>
      • Verify that your project structure is correct<br>
      • Look for missing dependencies or imports
    </div>
  </div>
</body>
</html>`;
      
      res.status(500).send(errorHtml);
    }
  });

  // Simple project preview endpoint that returns preview data
  app.get('/api/projects/:id/preview', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const files = await mongoStorage.getProjectFiles(id);
      const appJsFile = files.find((f: any) => f.name === 'App.js' || f.name === 'App.jsx');
      
      if (!appJsFile) {
        return res.status(400).json({ message: "App.js or App.jsx file not found" });
      }

      res.json({ 
        message: "Preview available",
        previewUrl: `/api/projects/${id}/preview-html`
      });
      
    } catch (error) {
      console.error("Error generating preview:", error);
      res.status(500).json({ message: "Failed to generate preview" });
    }
  });

  // Session storage for working directories (in production, use Redis or database)
  const sessionWorkingDirs = new Map<string, string>();

  // Enhanced terminal execution with package management support
  app.post('/api/terminal/execute', isAuthenticated, async (req: any, res) => {
    try {
      const { command, projectId } = req.body;
      const userId = req.user._id?.toString() || req.user.id;
      const sessionKey = `${userId}-${projectId}`;
      
      if (!command) {
        return res.status(400).json({ message: "Command is required" });
      }

      // Security: Only allow safe commands and command patterns
      const allowedCommands = [
        'npm', 'node', 'ls', 'pwd', 'cat', 'echo', 'date', 'whoami',
        'git', 'clear', 'help', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'cd',
        'python', 'python3', 'pip', 'pip3', 'pipenv', 'poetry', 'venv',
        'virtualenv', 'pytest', 'flake8', 'black', 'isort', 'mypy',
        'django-admin', 'flask', 'gunicorn', 'uvicorn', 'celery',
        'jupyter', 'ipython', 'conda', 'mamba', 'pdm', 'setuptools',
        'wheel', 'twine', 'pydoc', 'python-config', 'pyvenv',
        'javac', 'java', 'gcc', 'g++', 'make', 'cmake', 'cargo', 'rustc'
      ];
      
      // For shell commands with &&, validate each part
      const commandParts = command.split('&&').map(part => part.trim());
      for (const part of commandParts) {
        const partCommands = part.trim().split(' ');
        const baseCommand = partCommands[0].toLowerCase();
        
        // Special handling for Python module commands (python3 -m pip, python3 -m venv, etc.)
        const isPythonModuleCommand = baseCommand === 'python3' && partCommands[1] === '-m';
        
        if (!allowedCommands.includes(baseCommand) && !isPythonModuleCommand) {
          return res.json({ 
            output: `Command '${baseCommand}' is not allowed for security reasons.\nAllowed commands: ${allowedCommands.join(', ')}\nPython modules: python3 -m pip, python3 -m venv, python3 -m pytest, etc.`,
            type: 'error'
          });
        }
      }

      // Special handling for some commands
      if (command === 'clear') {
        return res.json({ output: '', type: 'clear' });
      }
      
      if (command === 'help') {
        return res.json({ 
          output: `Available commands:\n${allowedCommands.map(cmd => `  ${cmd}`).join('\n')}\n\nNote: Commands are executed in a secure sandbox environment.`,
          type: 'output'
        });
      }

      // Determine working directory - use stored session directory or default
      let workingDir = process.cwd();
      if (projectId) {
        const projectPath = path.join(process.cwd(), 'projects', projectId);
        try {
          await fs.access(projectPath);
          // Check if we have a stored working directory for this session
          const storedWorkingDir = sessionWorkingDirs.get(sessionKey);
          if (storedWorkingDir && storedWorkingDir.startsWith(projectPath)) {
            // Verify the stored directory still exists
            try {
              await fs.access(storedWorkingDir);
              workingDir = storedWorkingDir;
            } catch (error) {
              // Stored directory doesn't exist, fallback to project root
              workingDir = projectPath;
              sessionWorkingDirs.set(sessionKey, projectPath);
            }
          } else {
            workingDir = projectPath;
            sessionWorkingDirs.set(sessionKey, projectPath);
          }
        } catch (error) {
          // Project directory doesn't exist, create it
          await fs.mkdir(projectPath, { recursive: true });
          workingDir = projectPath;
          sessionWorkingDirs.set(sessionKey, projectPath);
        }
      }

      // Handle cd command specially - track working directory
      if (command.startsWith('cd ')) {
        const targetDir = command.substring(3).trim();
        let newWorkingDir = workingDir;
        
        if (targetDir === '..' || targetDir === '../') {
          // Go up one directory
          newWorkingDir = path.dirname(workingDir);
          // Don't go above project directory
          const projectPath = path.join(process.cwd(), 'projects', projectId);
          if (!newWorkingDir.startsWith(projectPath)) {
            newWorkingDir = projectPath;
          }
        } else if (targetDir === '.' || targetDir === './') {
          // Stay in current directory
          newWorkingDir = workingDir;
        } else if (targetDir.startsWith('/')) {
          // Absolute path within project
          const projectPath = path.join(process.cwd(), 'projects', projectId);
          newWorkingDir = path.join(projectPath, targetDir.substring(1));
        } else {
          // Relative path
          newWorkingDir = path.join(workingDir, targetDir);
        }
        
        // Check if target directory exists
        try {
          const stats = await fs.stat(newWorkingDir);
          if (stats.isDirectory()) {
            // Store the new working directory for this session
            sessionWorkingDirs.set(sessionKey, newWorkingDir);
            const relativePath = path.relative(path.join(process.cwd(), 'projects', projectId), newWorkingDir) || '/';
            return res.json({
              output: `Changed directory to: ${relativePath}`,
              type: 'output',
              workingDirectory: newWorkingDir
            });
          } else {
            return res.json({
              output: `cd: not a directory: ${targetDir}`,
              type: 'error'
            });
          }
        } catch (error) {
          return res.json({
            output: `cd: no such file or directory: ${targetDir}`,
            type: 'error'
          });
        }
      }

      // Sync files to disk before executing commands
      if (projectId) {

        // Sync database files to disk before executing commands
        try {
          console.log(`Syncing project files to disk before command execution`);
          const projectFiles = await mongoStorage.getProjectFiles(projectId);
          
          for (const file of projectFiles) {
            if (!file.isFolder && file.content !== null) {
              const filePath = path.join(workingDir, file.path);
              const fileDir = path.dirname(filePath);
              
              // Ensure directory exists
              await fs.mkdir(fileDir, { recursive: true });
              
              // Write file content to disk
              await fs.writeFile(filePath, file.content || '', 'utf8');
            }
          }
          console.log(`Synced ${projectFiles.filter(f => !f.isFolder).length} files to disk`);
        } catch (syncError) {
          console.warn(`Failed to sync files to disk:`, syncError);
        }
      }

      // Track if this is an npm command that might modify files
      const isPackageModifyingCommand = command.includes('npm install') || 
        command.includes('npm uninstall') || 
        command.includes('npm update') ||
        command.includes('npm add') ||
        command.includes('npm remove');

      // Setup proper command execution environment
      const commandEnv = {
        ...process.env,
        NODE_ENV: 'development',
        PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
        PWD: workingDir,
        HOME: process.env.HOME || '/home/runner',
        USER: process.env.USER || 'runner'
      };

      console.log(`Executing command: ${command}`);
      console.log(`Working directory: ${workingDir}`);
      console.log(`Environment PATH: ${commandEnv.PATH}`);

      // Execute command using shell for proper handling of operators like &&
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: workingDir,
        env: commandEnv,
        timeout: 120000, // 2 minute timeout for commands
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let error = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        error += data.toString();
      });

      child.on('close', async (code) => {
        // Combine stderr and stdout for better output
        let result = '';
        if (output) result += output;
        if (error) {
          if (result) result += '\n';
          result += error;
        }
        if (!result) result = `Command completed with exit code ${code}`;
        
        console.log(`Command '${command}' completed with code ${code}`);
        console.log(`Full output: ${result}`);
        
        // After any command that might modify files, sync the project immediately
        if (projectId) {
          try {
            console.log(`Syncing project files after command execution`);
            
            // Always sync basic files first for commands like touch, mkdir
            await fileSystemSync.syncProjectFiles({
              projectId,
              projectPath: workingDir,
              includeNodeModules: false,
              maxDepth: 5
            });
            
            // Additional sync for npm commands specifically
            if (isPackageModifyingCommand && code === 0) {
              console.log('Package command detected, waiting and syncing node_modules...');
              // Wait for npm to complete file operations
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              // Check if node_modules exists and sync it
              try {
                await fs.access(path.join(workingDir, 'node_modules'));
                console.log('Node_modules found, syncing...');
                await fileSystemSync.syncProjectFiles({
                  projectId,
                  projectPath: workingDir,
                  includeNodeModules: true,
                  maxDepth: 2
                });
              } catch (nmError) {
                console.log('Node_modules not accessible after npm command');
              }
            }
            
            console.log(`Project files sync completed`);
          } catch (syncError) {
            console.warn(`Failed to sync project files:`, syncError);
          }
        }
        
        
        res.json({ 
          output: result,
          type: code === 0 ? 'output' : 'error',
          exitCode: code,
          filesUpdated: isPackageModifyingCommand && code === 0,
          command: command // Include original command for debugging
        });
      });

      child.on('error', (err) => {
        res.json({ 
          output: `Error executing command: ${err.message}`,
          type: 'error'
        });
      });
      
    } catch (error) {
      console.error("Error executing terminal command:", error);
      res.status(500).json({ message: "Failed to execute command" });
    }
  });

  // Manual file sync endpoint
  app.post('/api/projects/:id/sync', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const projectPath = path.join(process.cwd(), 'projects', id);
      
      console.log(`Manual sync requested for project ${id}`);
      
      // Trigger file system sync
      await fileSystemSync.syncProjectFiles({
        projectId: id,
        projectPath: projectPath,
        includeNodeModules: false,
        maxDepth: 5
      });
      
      console.log(`Manual sync completed for project ${id}`);
      res.json({ message: "Sync completed successfully" });
    } catch (error) {
      console.error("Error during manual sync:", error);
      res.status(500).json({ message: "Failed to sync project files" });
    }
  });

  // Auto-run project based on language detection
  app.post('/api/projects/:id/run', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const project = await mongoStorage.getProject(id);
      
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const files = await mongoStorage.getProjectFiles(id);
      const language = detectProjectLanguage(files);
      
      let command = '';
      let description = '';
      
      // Check if dependencies are installed for Node.js projects
      const hasPackageJson = files.some(f => f.name === 'package.json');
      const hasNodeModules = files.some(f => f.name === 'node_modules' && f.isFolder);
      
      switch (language) {
        case 'python':
          command = 'python main.py';
          description = 'Running Python application';
          break;
        case 'react':
          if (hasPackageJson && !hasNodeModules) {
            command = 'npm install && npm start';
            description = 'Installing dependencies and starting React development server';
          } else {
            command = 'npm start';
            description = 'Starting React development server';
          }
          break;
        case 'javascript':
          if (hasPackageJson && !hasNodeModules) {
            command = 'npm install && npm start';
            description = 'Installing dependencies and starting Node.js application';
          } else {
            command = 'npm start';
            description = 'Starting Node.js application';
          }
          break;
        case 'html':
          return res.json({
            type: 'preview',
            previewUrl: `/api/projects/${id}/preview-html`,
            description: 'Opening HTML preview'
          });
        default:
          return res.status(400).json({ message: 'Unknown project language' });
      }
      
      res.json({
        type: 'terminal',
        command,
        description,
        projectId: id
      });
    } catch (error) {
      console.error('Error running project:', error);
      res.status(500).json({ message: 'Failed to run project' });
    }
  });

  // Helper function to detect project language
  function detectProjectLanguage(files: any[]): string {
    const fileNames = files.map(f => f.name.toLowerCase());
    const filePaths = files.map(f => f.path.toLowerCase());
    
    // Check for Python files
    if (fileNames.includes('main.py') || filePaths.some(p => p.endsWith('.py'))) {
      return 'python';
    }
    
    // Check for React files
    if (fileNames.includes('app.jsx') || fileNames.includes('app.js') || 
        filePaths.some(p => p.endsWith('.jsx') || p.endsWith('.tsx'))) {
      return 'react';
    }
    
    // Check for HTML files
    if (fileNames.includes('index.html') || filePaths.some(p => p.endsWith('.html'))) {
      return 'html';
    }
    
    // Check for Node.js project
    if (fileNames.includes('package.json')) {
      return 'javascript';
    }
    
    return 'unknown';
  }

  // User preferences routes
  app.get('/api/user/preferences', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const preferences = await mongoStorage.getUserPreferences(userId);
      
      // Return default preferences if none exist
      if (!preferences) {
        const defaultPrefs = {
          userId,
          theme: 'dark',
          sidebarState: true,
          preferences: {}
        };
        res.json(defaultPrefs);
      } else {
        res.json(preferences);
      }
    } catch (error) {
      console.error("Error fetching user preferences:", error);
      res.status(500).json({ message: "Failed to fetch preferences" });
    }
  });

  app.put('/api/user/preferences', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const preferencesData = insertUserPreferencesSchema.parse({
        ...req.body,
        userId
      });
      
      const preferences = await mongoStorage.upsertUserPreferences(preferencesData);
      res.json(preferences);
    } catch (error) {
      console.error("Error updating user preferences:", error);
      res.status(500).json({ message: "Failed to update preferences" });
    }
  });

  // Project data routes (for todos, notes, etc.)
  app.get('/api/projects/:projectId/data/:dataType', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { projectId, dataType } = req.params;
      
      // Check project access
      const project = await mongoStorage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      const hasAccess = projectOwnerId === userId || project.isPublic;
      if (!hasAccess) {
        const collaboration = await mongoStorage.getCollaboration(projectId, userId);
        if (!collaboration) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const data = await mongoStorage.getProjectData(projectId, userId, dataType);
      if (!data) {
        // Return empty data for the requested type
        return res.json({ 
          projectId, 
          userId, 
          dataType, 
          data: dataType === 'todos' ? [] : {} 
        });
      }
      
      res.json(data);
    } catch (error) {
      console.error("Error fetching project data:", error);
      res.status(500).json({ message: "Failed to fetch project data" });
    }
  });

  app.put('/api/projects/:projectId/data/:dataType', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user._id?.toString() || req.user.id;
      const { projectId, dataType } = req.params;
      
      // Check project access
      const project = await mongoStorage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const projectOwnerId = typeof project.ownerId === 'object' && project.ownerId && '_id' in project.ownerId 
        ? project.ownerId._id.toString() 
        : project.ownerId?.toString() || project.ownerId;
      const hasAccess = projectOwnerId === userId;
      if (!hasAccess) {
        const collaboration = await mongoStorage.getCollaboration(projectId, userId);
        if (!collaboration || collaboration.role === 'viewer') {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const projectDataInfo = insertProjectDataSchema.parse({
        projectId,
        userId,
        dataType,
        data: req.body.data
      });
      
      const data = await mongoStorage.upsertProjectData(projectDataInfo);
      res.json(data);
    } catch (error) {
      console.error("Error updating project data:", error);
      res.status(500).json({ message: "Failed to update project data" });
    }
  });

  // Admin routes
  // Get all users (admin only)
  app.get('/api/admin/users', isAdmin, async (req: any, res) => {
    try {
      const users = await mongoStorage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching all users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Get all projects (admin only)
  app.get('/api/admin/projects', isAdmin, async (req: any, res) => {
    try {
      const projects = await mongoStorage.getAllProjects();
      res.json(projects);
    } catch (error) {
      console.error("Error fetching all projects:", error);
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  // Get projects by user ID (admin only)
  app.get('/api/admin/users/:userId/projects', isAdmin, async (req: any, res) => {
    try {
      const { userId } = req.params;
      const projects = await mongoStorage.getUserProjects(userId);
      res.json(projects);
    } catch (error) {
      console.error("Error fetching user projects:", error);
      res.status(500).json({ message: "Failed to fetch user projects" });
    }
  });

  // Update user (admin only)
  app.put('/api/admin/users/:id', isAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;
      
      // Remove sensitive fields that shouldn't be mass-assigned
      const { _id, createdAt, updatedAt, ...safeUpdateData } = updateData;
      
      const updatedUser = await mongoStorage.updateUser(id, safeUpdateData);
      
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // Update project (admin only)
  app.put('/api/admin/projects/:id', isAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;
      
      // Remove sensitive fields that shouldn't be mass-assigned
      const { _id, createdAt, updatedAt, ...safeUpdateData } = updateData;
      
      const updatedProject = await mongoStorage.updateProject(id, safeUpdateData);
      
      if (!updatedProject) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      res.json(updatedProject);
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ message: "Failed to update project" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
