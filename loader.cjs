"use strict";

const path = require("path");
const fs = require("fs");

/**
 * Webpack/Turbopack loader that transforms cronStart() calls.
 * 
 * This loader runs during compilation to transform cronStart() calls
 * into start() calls with the pre-generated wrapper workflows.
 * 
 * The transformation happens AFTER the wrapper files have been generated
 * by the builder during Next.js startup.
 */

/**
 * Find the wrapper directory (inside src/app or app)
 * @param {string} workingDir
 * @returns {string}
 */
function getCronWrapperDir(workingDir) {
    // Check for cron-wrappers in src/app (primary location)
    const srcAppDir = path.join(workingDir, "src", "app", "cron-wrappers");
    if (fs.existsSync(srcAppDir)) {
        return srcAppDir;
    }
    
    // Check for cron-wrappers in app
    const appDir = path.join(workingDir, "app", "cron-wrappers");
    if (fs.existsSync(appDir)) {
        return appDir;
    }
    
    // Fallback - return src/app path even if doesn't exist yet
    return srcAppDir;
}

/**
 * Extract all cronStart() calls from the source
 * @param {string} source
 * @returns {Array<{workflowName: string, argsNode: string, optionsNode: string, originalCall: string}>}
 */
function extractCronStartCalls(source) {
    const calls = [];
    
    // Match cronStart with balanced brackets/braces
    const cronStartPattern = /cronStart\s*\(\s*(\w+)\s*,\s*(\[[^\]]*\]|\w+)\s*,\s*(\{[^}]*\}|\w+)\s*\)/g;
    
    let match;
    while ((match = cronStartPattern.exec(source)) !== null) {
        calls.push({
            workflowName: match[1],
            argsNode: match[2],
            optionsNode: match[3],
            originalCall: match[0]
        });
    }

    return calls;
}

/**
 * Update imports: remove cronStart, add start and wrapper imports
 * @param {string} source
 * @param {Array<{workflowName: string}>} calls
 * @param {string} resourcePath - Path to the file being transformed
 * @param {string} workingDir - Working directory (project root)
 * @returns {string}
 */
function updateImports(source, calls, resourcePath, workingDir) {
    let result = source;

    // Remove cronStart from the import
    result = result.replace(
        /import\s*\{\s*cronStart\s*\}\s*from\s*["']workflow-cron-start["']\s*;?\n?/g,
        ""
    );

    // Handle partial imports
    result = result.replace(
        /import\s*\{([^}]*),\s*cronStart\s*,([^}]*)\}\s*from\s*["']workflow-cron-start["']/g,
        'import {$1,$2} from "workflow-cron-start"'
    );
    result = result.replace(
        /import\s*\{([^}]*),\s*cronStart\s*\}\s*from\s*["']workflow-cron-start["']/g,
        'import {$1} from "workflow-cron-start"'
    );
    result = result.replace(
        /import\s*\{\s*cronStart\s*,([^}]*)\}\s*from\s*["']workflow-cron-start["']/g,
        'import {$1} from "workflow-cron-start"'
    );

    // Clean up empty imports
    result = result.replace(/import\s*\{\s*\}\s*from\s*["']workflow-cron-start["']\s*;?\n?/g, "");

    // Build new imports
    const newImports = [];
    
    // Only add start import if not already present
    const hasStartImport = /import\s*\{[^}]*\bstart\b[^}]*\}\s*from\s*["']workflow\/api["']/.test(result);
    if (!hasStartImport) {
        newImports.push('import { start } from "workflow/api"');
    }
    
    // Calculate relative path from the current file to the wrapper directory
    const wrapperDir = getCronWrapperDir(workingDir);
    const resourceDir = path.dirname(resourcePath);
    let relativeToWrapper = path.relative(resourceDir, wrapperDir).replace(/\\/g, "/");
    
    // Ensure it starts with ./
    if (!relativeToWrapper.startsWith(".")) {
        relativeToWrapper = "./" + relativeToWrapper;
    }
    
    const seenWrappers = new Set();
    for (const call of calls) {
        const wrapperName = `__cron__${call.workflowName}`;
        const triggerDirName = `trigger-${call.workflowName}`;
        if (!seenWrappers.has(wrapperName)) {
            seenWrappers.add(wrapperName);
            // Import from the workflow.ts file inside the trigger subdirectory
            newImports.push(
                `import { ${wrapperName} } from "${relativeToWrapper}/${triggerDirName}/workflow"`
            );
        }
    }

    const newImportsStr = newImports.join("\n") + "\n";

    // Insert after last import
    const lastImportMatch = result.match(/^import\s+.+from\s+["'][^"']+["'];?\s*$/gm);
    if (lastImportMatch) {
        const lastImport = lastImportMatch[lastImportMatch.length - 1];
        const lastImportIndex = result.lastIndexOf(lastImport);
        const insertPosition = lastImportIndex + lastImport.length;
        result = result.slice(0, insertPosition) + "\n" + newImportsStr + result.slice(insertPosition);
    } else {
        result = newImportsStr + result;
    }

    return result;
}

/**
 * Replace cronStart() calls with start() calls
 * @param {string} source
 * @param {Array<{workflowName: string, argsNode: string, optionsNode: string, originalCall: string}>} calls
 * @returns {string}
 */
function replaceCronStartCalls(source, calls) {
    let result = source;

    for (const call of calls) {
        const wrapperName = `__cron__${call.workflowName}`;
        
        let mergedOptions;
        if (call.optionsNode.startsWith("{")) {
            const optionsContent = call.optionsNode.slice(1, -1).trim();
            mergedOptions = `{ args: ${call.argsNode}, ${optionsContent} }`;
        } else {
            mergedOptions = `{ args: ${call.argsNode}, ...${call.optionsNode} }`;
        }
        
        const replacement = `start(${wrapperName}, [${mergedOptions}])`;
        result = result.replace(call.originalCall, replacement);
    }

    return result;
}

/**
 * Transform cronStart() calls to use generated wrappers
 * @param {string} source
 * @param {string} resourcePath
 * @param {string} workingDir
 * @returns {{code: string, transformed: boolean}}
 */
function transformCronStartCalls(source, resourcePath, workingDir) {
    // Quick check - skip if no cronStart
    if (!source.includes("cronStart")) {
        return { code: source, transformed: false };
    }

    // Check if this file imports cronStart from our package
    const cronStartImportRegex = /import\s*\{[^}]*cronStart[^}]*\}\s*from\s*["']workflow-cron-start["']/;
    if (!cronStartImportRegex.test(source)) {
        return { code: source, transformed: false };
    }

    // Find all cronStart calls
    const cronStartCalls = extractCronStartCalls(source);
    
    if (cronStartCalls.length === 0) {
        return { code: source, transformed: false };
    }

    // Transform the code
    let transformedSource = source;
    transformedSource = updateImports(transformedSource, cronStartCalls, resourcePath, workingDir);
    transformedSource = replaceCronStartCalls(transformedSource, cronStartCalls);

    return { code: transformedSource, transformed: true };
}

/**
 * Webpack/Turbopack loader function
 * @param {string | Buffer} source
 * @returns {Promise<string>}
 */
async function cronStartLoader(source) {
    const normalizedSource = source.toString();
    const resourcePath = this.resourcePath || "";
    
    // Skip files inside node_modules (don't transform dependencies)
    if (resourcePath.includes("node_modules")) {
        return normalizedSource;
    }
    
    // Skip files inside workflow-cron-start package itself
    if (resourcePath.includes("workflow-cron-start")) {
        return normalizedSource;
    }
    
    // Quick check - skip files without cronStart
    if (!normalizedSource.includes("cronStart")) {
        return normalizedSource;
    }

    // Check if this file imports cronStart from our package
    if (!normalizedSource.includes("workflow-cron-start")) {
        return normalizedSource;
    }

    try {
        // Get the working directory from the loader context
        const workingDir = this.rootContext || process.cwd();
        
        const result = transformCronStartCalls(normalizedSource, resourcePath, workingDir);
        
        if (result.transformed) {
            console.log(`[workflow-cron-start] Transformed cronStart() in ${this.resourcePath}`);
        }
        
        return result.code;
    } catch (error) {
        console.error(`[workflow-cron-start] Error transforming ${this.resourcePath}:`, error);
        return normalizedSource;
    }
}

module.exports = cronStartLoader;
module.exports.default = cronStartLoader;
