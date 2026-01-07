const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// Get event payload from environment or stdin
const eventPayload = process.env.GITHUB_EVENT_PAYLOAD 
  ? JSON.parse(process.env.GITHUB_EVENT_PAYLOAD)
  : JSON.parse(process.argv[2] || '{}');

const {
  action,
  repository,
  pull_request,
  organization
} = eventPayload;

// Validate required fields
if (!action || !repository || !pull_request) {
  console.error('Missing required event payload fields');
  process.exit(1);
}

const repoName = repository.name;
const prNumber = pull_request.number;
const commitSha = pull_request.head.sha;
const repoFullName = repository.full_name;
const repoOwner = repository.owner.login;
const previewRepoOwner = config.previewRepository.owner;
const previewRepoName = config.previewRepository.name;
const previewPath = `${repoName}/${prNumber}`;

// Check if repository is monitored
if (!config.monitoredRepositories.includes(repoName)) {
  console.log(`Repository ${repoName} is not in monitored list. Skipping.`);
  process.exit(0);
}

console.log(`Processing PR #${prNumber} from ${repoFullName} (action: ${action})`);

// Route by action
if (action === 'opened' || action === 'synchronize') {
  handlePreviewGeneration();
} else if (action === 'closed' || action === 'merged') {
  handleCleanup();
} else {
  console.log(`Action ${action} not handled. Skipping.`);
  process.exit(0);
}

async function handlePreviewGeneration() {
  try {
    const tempDir = path.join('/tmp', `preview-${Date.now()}`);
    const previewDir = path.join('/tmp', `preview-repo-${Date.now()}`);

    // Step 1: Clone source repository at commit
    console.log(`Cloning ${repoFullName} at commit ${commitSha}...`);
    execSync(`git clone https://github.com/${repoFullName}.git ${tempDir}`, { stdio: 'inherit' });
    process.chdir(tempDir);
    execSync(`git checkout ${commitSha}`, { stdio: 'inherit' });

    // Step 2: Run build script
    // Based on ci_boost_release.py approach: prioritize Antora build scripts
    console.log('Looking for build script...');
    
    // Repository-specific build scripts (prioritized, matching Python logic)
    // Check for Antora scripts first (doc/antora_docs.sh or doc/build_antora.sh)
    const repoSpecificScripts = [
      'doc/antora_docs.sh',      // Alternative Antora script name
      'doc/build_antora.sh',     // Primary Antora build script
      'doc/build_antora.ps1',    // PowerShell version
      'doc/build.sh',            // Generic build script in doc/
      'doc/generate-docs.sh',     // Generate docs script
      'doc/build-docs.sh'        // Build docs script
    ];
    
    // Generic build scripts (fallback)
    const genericScripts = [
      'build-docs.sh',
      'generate-docs.sh',
      'build.sh',
      'npm run build-docs',
      'npm run generate-docs',
      'python generate_docs.py',
      './generate.sh'
    ];
    
    // Combine: repo-specific first, then generic
    const buildScripts = [...repoSpecificScripts, ...genericScripts];

    let buildExecuted = false;
    for (const script of buildScripts) {
      // Handle npm/python commands (execute from repo root)
      if (script.includes('npm run') || script.includes('python')) {
        try {
          console.log(`Trying: ${script}`);
          execSync(script, { stdio: 'inherit', cwd: tempDir });
          buildExecuted = true;
          break;
        } catch (e) {
          continue;
        }
      } 
      // Handle shell scripts (check if file exists, then execute)
      else {
        const scriptPath = path.join(tempDir, script);
        if (fs.existsSync(scriptPath)) {
          console.log(`Found build script: ${script}`);
          const scriptDir = path.dirname(scriptPath);
          const scriptName = path.basename(scriptPath);
          
          // Convert line endings with dos2unix if available (matching Python approach)
          // This ensures scripts work correctly regardless of line endings
          try {
            execSync(`which dos2unix > /dev/null 2>&1 && dos2unix "${scriptPath}" || true`, { 
              stdio: 'inherit',
              shell: '/bin/bash'
            });
          } catch (e) {
            // dos2unix not available, continue without it
          }
          
          // Make script executable and run it from its directory
          console.log(`Executing: ${script}`);
          execSync(`chmod +x "${scriptPath}" && bash "${scriptPath}"`, { 
            stdio: 'inherit',
            cwd: scriptDir,
            shell: '/bin/bash'
          });
          buildExecuted = true;
          break;
        }
      }
    }

    if (!buildExecuted) {
      console.warn('No build script found. Looking for HTML files in common directories...');
    }

    // Step 3: Find generated HTML files
    // Check common output directories (relative to repo root)
    // Note: Antora scripts often output to doc/html/ when run from doc/ directory
    const htmlDirs = ['doc/html', 'dist', 'output', 'docs/html', 'build', 'html', '.'];
    let htmlFiles = [];
    
    for (const dir of htmlDirs) {
      const dirPath = path.join(tempDir, dir);
      if (fs.existsSync(dirPath)) {
        const files = findHtmlFiles(dirPath);
        if (files.length > 0) {
          htmlFiles = files;
          console.log(`Found ${files.length} HTML files in ${dir}`);
          break;
        }
      }
    }

    if (htmlFiles.length === 0) {
      console.error('No HTML files found. Build script may not have generated output.');
      process.exit(1);
    }

    // Convert relative paths to absolute paths before changing directory
    const absoluteHtmlFiles = htmlFiles.map(file => {
      if (path.isAbsolute(file)) {
        return file;
      }
      return path.resolve(tempDir, file);
    });

    // Step 4: Clone preview repository
    console.log(`Cloning preview repository ${previewRepoOwner}/${previewRepoName}...`);
    const previewToken = process.env.PREVIEW_REPO_TOKEN;
    if (!previewToken) {
      throw new Error('PREVIEW_REPO_TOKEN environment variable is required');
    }
    execSync(`git clone https://${previewToken}@github.com/${previewRepoOwner}/${previewRepoName}.git ${previewDir}`, { stdio: 'inherit' });
    process.chdir(previewDir);
    
    // Update remote URL to ensure token is used for push operations
    execSync(`git remote set-url origin https://${previewToken}@github.com/${previewRepoOwner}/${previewRepoName}.git`, { stdio: 'inherit' });

    // Step 5: Copy HTML files to preview path
    console.log(`Copying HTML files to ${previewPath}...`);
    const targetDir = path.join(previewDir, previewPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Copy files maintaining directory structure
    for (const file of absoluteHtmlFiles) {
      const relativePath = path.relative(tempDir, file);
      const targetFile = path.join(targetDir, relativePath);
      const targetFileDir = path.dirname(targetFile);
      
      if (!fs.existsSync(targetFileDir)) {
        fs.mkdirSync(targetFileDir, { recursive: true });
      }
      
      if (!fs.existsSync(file)) {
        console.error(`Source file does not exist: ${file}`);
        continue;
      }
      
      fs.copyFileSync(file, targetFile);
      console.log(`Copied: ${relativePath}`);
    }

    // Step 6: Commit and push
    console.log('Committing changes...');
    execSync('git config user.name "GitHub Actions"', { stdio: 'inherit' });
    execSync('git config user.email "actions@github.com"', { stdio: 'inherit' });
    execSync(`git add ${previewPath}`, { stdio: 'inherit' });
    
    try {
      execSync(`git commit -m "Update preview for ${repoName}#${prNumber} (${commitSha.substring(0, 7)})"`, { stdio: 'inherit' });
      execSync(`git push https://${previewToken}@github.com/${previewRepoOwner}/${previewRepoName}.git main`, { stdio: 'inherit' });
      console.log('Preview updated successfully!');
    } catch (e) {
      if (e.message.includes('nothing to commit')) {
        console.log('No changes to commit.');
      } else {
        throw e;
      }
    }

    // Cleanup
    process.chdir('/');
    execSync(`rm -rf ${tempDir} ${previewDir}`, { stdio: 'inherit' });

  } catch (error) {
    console.error('Error generating preview:', error);
    process.exit(1);
  }
}

async function handleCleanup() {
  try {
    const previewDir = path.join('/tmp', `preview-repo-cleanup-${Date.now()}`);

    // Step 1: Clone preview repository
    console.log(`Cloning preview repository ${previewRepoOwner}/${previewRepoName}...`);
    const previewToken = process.env.PREVIEW_REPO_TOKEN;
    if (!previewToken) {
      throw new Error('PREVIEW_REPO_TOKEN environment variable is required');
    }
    execSync(`git clone https://${previewToken}@github.com/${previewRepoOwner}/${previewRepoName}.git ${previewDir}`, { stdio: 'inherit' });
    process.chdir(previewDir);
    
    // Update remote URL to ensure token is used for push operations
    execSync(`git remote set-url origin https://${previewToken}@github.com/${previewRepoOwner}/${previewRepoName}.git`, { stdio: 'inherit' });

    // Step 2: Delete PR folder
    const targetPath = path.join(previewDir, previewPath);
    if (fs.existsSync(targetPath)) {
      console.log(`Deleting ${previewPath}...`);
      execSync(`rm -rf ${targetPath}`, { stdio: 'inherit' });

      // Step 3: Commit and push
      console.log('Committing deletion...');
      execSync('git config user.name "GitHub Actions"', { stdio: 'inherit' });
      execSync('git config user.email "actions@github.com"', { stdio: 'inherit' });
      execSync(`git add -A`, { stdio: 'inherit' });
      
      try {
        execSync(`git commit -m "Remove preview for ${repoName}#${prNumber}"`, { stdio: 'inherit' });
        execSync(`git push https://${previewToken}@github.com/${previewRepoOwner}/${previewRepoName}.git main`, { stdio: 'inherit' });
        console.log('Preview cleanup completed!');
      } catch (e) {
        if (e.message.includes('nothing to commit')) {
          console.log('No changes to commit.');
        } else {
          throw e;
        }
      }
    } else {
      console.log(`Preview folder ${previewPath} does not exist. Nothing to clean up.`);
    }

    // Cleanup
    process.chdir('/');
    execSync(`rm -rf ${previewDir}`, { stdio: 'inherit' });

  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
}

function findHtmlFiles(dir) {
  const files = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.resolve(dir, item.name);
    if (item.isDirectory()) {
      files.push(...findHtmlFiles(fullPath));
    } else if (item.isFile() && item.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

