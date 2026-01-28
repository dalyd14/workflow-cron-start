/**
 * Scanner module for finding cronStart() calls in source files.
 * 
 * This module scans source files to find cronStart() calls and extracts
 * information about the workflow functions being scheduled.
 */

import { readFile, readFile as readFileAsync } from "node:fs/promises"
import { relative, dirname, resolve, join } from "node:path"
import { existsSync } from "node:fs"

/**
 * Parsed tsconfig paths configuration
 */
export interface TsconfigPaths {
    baseUrl?: string
    paths: Record<string, string[]>
}

/**
 * Cache for tsconfig paths to avoid re-reading the file
 */
let tsconfigPathsCache: TsconfigPaths | null = null
let tsconfigPathsCacheDir: string | null = null

/**
 * Read and parse tsconfig.json to extract path aliases.
 * Supports extends and follows the inheritance chain.
 */
export async function readTsconfigPaths(workingDir: string): Promise<TsconfigPaths> {
    // Return cached result if available for the same directory
    if (tsconfigPathsCache && tsconfigPathsCacheDir === workingDir) {
        return tsconfigPathsCache
    }

    const result: TsconfigPaths = { paths: {} }

    // Try tsconfig.json first, then jsconfig.json
    const configFiles = ["tsconfig.json", "jsconfig.json"]

    for (const configFile of configFiles) {
        const configPath = join(workingDir, configFile)
        if (!existsSync(configPath)) continue

        try {
            const content = await readFileAsync(configPath, "utf-8")
            // Remove comments (simple approach - handles // and /* */ comments)
            const jsonContent = content
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/\/\/.*/g, "")

            const config = JSON.parse(jsonContent)

            // Extract baseUrl
            if (config.compilerOptions?.baseUrl) {
                result.baseUrl = config.compilerOptions.baseUrl
            }

            // Extract paths
            if (config.compilerOptions?.paths) {
                result.paths = { ...result.paths, ...config.compilerOptions.paths }
            }

            // Handle extends (simplified - just one level)
            if (config.extends) {
                const extendedPath = resolve(workingDir, config.extends)
                const extendedDir = dirname(extendedPath)
                const extendedFile = extendedPath.endsWith(".json")
                    ? extendedPath
                    : `${extendedPath}.json`

                if (existsSync(extendedFile)) {
                    try {
                        const extContent = await readFileAsync(extendedFile, "utf-8")
                        const extJsonContent = extContent
                            .replace(/\/\*[\s\S]*?\*\//g, "")
                            .replace(/\/\/.*/g, "")
                        const extConfig = JSON.parse(extJsonContent)

                        if (extConfig.compilerOptions?.baseUrl && !result.baseUrl) {
                            result.baseUrl = extConfig.compilerOptions.baseUrl
                        }
                        if (extConfig.compilerOptions?.paths) {
                            // Existing paths take precedence over extended
                            result.paths = { ...extConfig.compilerOptions.paths, ...result.paths }
                        }
                    } catch {
                        // Ignore errors reading extended config
                    }
                }
            }

            break // Found and parsed a config, stop looking
        } catch {
            // Ignore JSON parse errors, try next config file
            continue
        }
    }

    // Cache the result
    tsconfigPathsCache = result
    tsconfigPathsCacheDir = workingDir

    return result
}

/**
 * Resolve a path alias using tsconfig paths.
 * Returns the resolved absolute path, or null if no match.
 */
export function resolvePathAlias(
    importPath: string,
    workingDir: string,
    tsconfigPaths: TsconfigPaths
): string | null {
    const { baseUrl = ".", paths } = tsconfigPaths
    const absoluteBaseUrl = resolve(workingDir, baseUrl)

    // Try to match each path pattern
    for (const [pattern, mappings] of Object.entries(paths)) {
        // Convert glob pattern to regex
        // "@/*" becomes /^@\/(.*)$/
        const patternRegex = new RegExp(
            "^" + pattern.replace(/\*/g, "(.*)") + "$"
        )

        const match = importPath.match(patternRegex)
        if (match) {
            // Use the first mapping (most path aliases only have one)
            const mapping = mappings[0]
            if (!mapping) continue

            // Replace the * in the mapping with the captured group
            const captured = match[1] || ""
            const resolvedPath = mapping.replace("*", captured)

            return resolve(absoluteBaseUrl, resolvedPath)
        }
    }

    return null
}

/**
 * Convert an absolute path to an alias import if possible.
 * This is the reverse of resolvePathAlias.
 * 
 * @param absolutePath - The absolute path to convert
 * @param workingDir - The working directory (project root)
 * @param tsconfigPaths - The parsed tsconfig paths
 * @returns The alias import string (e.g., "@/lib/workflow") or null if no alias matches
 */
export function absolutePathToAlias(
    absolutePath: string,
    workingDir: string,
    tsconfigPaths: TsconfigPaths
): string | null {
    const { baseUrl = ".", paths } = tsconfigPaths
    const absoluteBaseUrl = resolve(workingDir, baseUrl)

    // Normalize the path for comparison
    const normalizedPath = absolutePath.replace(/\\/g, "/")

    // Try each path alias pattern
    for (const [pattern, mappings] of Object.entries(paths)) {
        // Use the first mapping
        const mapping = mappings[0]
        if (!mapping) continue

        // Convert mapping to absolute path pattern
        // "./src/*" becomes "/abs/path/to/project/src/"
        const mappingBase = mapping.replace("*", "")
        const absoluteMappingBase = resolve(absoluteBaseUrl, mappingBase).replace(/\\/g, "/")

        // Check if the absolute path starts with this mapping
        if (normalizedPath.startsWith(absoluteMappingBase)) {
            // Extract the part after the mapping base
            const remainder = normalizedPath.slice(absoluteMappingBase.length)

            // Build the alias import
            // Pattern "@/*" with remainder "lib/workflow" becomes "@/lib/workflow"
            const aliasPrefix = pattern.replace("*", "")
            return aliasPrefix + remainder
        }
    }

    return null
}

/**
 * Check if an import path is a path alias (not relative, not a package).
 */
export function isPathAlias(
    importPath: string,
    tsconfigPaths: TsconfigPaths
): boolean {
    // Relative imports are not aliases
    if (importPath.startsWith(".")) {
        return false
    }

    // Check if it matches any tsconfig path pattern
    for (const pattern of Object.keys(tsconfigPaths.paths)) {
        const patternRegex = new RegExp(
            "^" + pattern.replace(/\*/g, "(.*)") + "$"
        )
        if (patternRegex.test(importPath)) {
            return true
        }
    }

    // Common alias patterns even if not in tsconfig
    const commonAliases = ["@/", "~/", "#/", "src/"]
    return commonAliases.some(alias => importPath.startsWith(alias))
}

/**
 * Information about a cronStart() call found in source code
 */
export interface CronStartCall {
    /** Name of the workflow function being scheduled (e.g., "sendReport") */
    workflowFunctionName: string

    /** Import path for the workflow (e.g., "@/lib/workflow" or "./workflow") */
    importPath: string

    /** Absolute path to the source file containing the cronStart() call */
    sourceFile: string
}

/**
 * Scan source files for cronStart() calls and extract workflow information.
 * 
 * @param files - Array of absolute file paths to scan
 * @param workingDir - The working directory for resolving relative paths
 * @returns Array of CronStartCall objects describing found calls
 */
export async function scanForCronStartCalls(
    files: string[],
    workingDir: string
): Promise<CronStartCall[]> {
    const calls: CronStartCall[] = []

    for (const file of files) {
        try {
            const content = await readFile(file, "utf-8")
            const fileCalls = extractCronStartCallsFromSource(content, file)
            calls.push(...fileCalls)
        } catch (error) {
            // Skip files that can't be read (e.g., binary files, permission issues)
            continue
        }
    }

    return deduplicateCalls(calls)
}

/**
 * Extract cronStart() calls from a single source file's content.
 */
function extractCronStartCallsFromSource(
    source: string,
    sourceFile: string
): CronStartCall[] {
    const calls: CronStartCall[] = []

    // Quick check - skip if no cronStart
    if (!source.includes("cronStart")) {
        return calls
    }

    // Check if this file imports cronStart from our package
    const cronStartImportRegex = /import\s*\{[^}]*cronStart[^}]*\}\s*from\s*["']workflow-cron-start["']/
    if (!cronStartImportRegex.test(source)) {
        return calls
    }

    // Find all import statements to build a map of imported identifiers to their sources
    const importMap = buildImportMap(source)

    // Find all cronStart() calls and extract the workflow function name
    // Pattern: cronStart(workflowFn, args, options)
    const cronStartPattern = /cronStart\s*\(\s*(\w+)\s*,/g

    let match
    while ((match = cronStartPattern.exec(source)) !== null) {
        const workflowFunctionName = match[1]

        // Look up the import path for this workflow function
        const importPath = importMap.get(workflowFunctionName)

        if (importPath) {
            calls.push({
                workflowFunctionName,
                importPath,
                sourceFile,
            })
        } else {
            // Workflow function is defined in the same file or imported with a different pattern
            // We'll generate a relative import from the wrapper to this file
            calls.push({
                workflowFunctionName,
                importPath: `./${relative(dirname(sourceFile), sourceFile).replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, "")}`,
                sourceFile,
            })
        }
    }

    return calls
}

/**
 * Build a map of imported identifiers to their import paths.
 */
function buildImportMap(source: string): Map<string, string> {
    const importMap = new Map<string, string>()

    // Match various import patterns:
    // import { foo } from "path"
    // import { foo, bar } from "path"
    // import { foo as bar } from "path"
    // import foo from "path"

    // Named imports: import { x, y } from "path"
    const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g
    let match

    while ((match = namedImportRegex.exec(source)) !== null) {
        const imports = match[1]
        const importPath = match[2]

        // Parse individual imports (handle "as" aliases)
        const importParts = imports.split(",").map(s => s.trim())
        for (const part of importParts) {
            if (!part) continue

            // Handle "foo as bar" syntax
            const asMatch = part.match(/(\w+)\s+as\s+(\w+)/)
            if (asMatch) {
                // Use the alias (what's used in code)
                importMap.set(asMatch[2], importPath)
            } else {
                // Simple import
                const cleanName = part.trim()
                if (cleanName) {
                    importMap.set(cleanName, importPath)
                }
            }
        }
    }

    // Default imports: import foo from "path"
    const defaultImportRegex = /import\s+(\w+)\s+from\s*["']([^"']+)["']/g
    while ((match = defaultImportRegex.exec(source)) !== null) {
        // Skip if this looks like a named import (has braces)
        const fullMatch = match[0]
        if (fullMatch.includes("{")) continue

        const importName = match[1]
        const importPath = match[2]
        importMap.set(importName, importPath)
    }

    return importMap
}

/**
 * Remove duplicate calls (same workflow function from same source).
 */
function deduplicateCalls(calls: CronStartCall[]): CronStartCall[] {
    const seen = new Set<string>()
    const result: CronStartCall[] = []

    for (const call of calls) {
        // Create a unique key combining workflow name and import path
        const key = `${call.workflowFunctionName}:${call.importPath}`

        if (!seen.has(key)) {
            seen.add(key)
            result.push(call)
        }
    }

    return result
}

/**
 * Resolve an import path to an absolute file path.
 * Handles relative imports and path aliases from tsconfig.
 */
export function resolveImportPath(
    importPath: string,
    fromFile: string,
    workingDir: string,
    tsconfigPaths?: TsconfigPaths
): string {
    // Handle relative imports
    if (importPath.startsWith(".")) {
        const fromDir = dirname(fromFile)
        return resolve(fromDir, importPath)
    }

    // Try to resolve using tsconfig paths if available
    if (tsconfigPaths) {
        const resolved = resolvePathAlias(importPath, workingDir, tsconfigPaths)
        if (resolved) {
            return resolved
        }
    }

    // Fallback: Handle @/ alias (common Next.js pattern)
    // This is used when tsconfig paths are not available or don't match
    if (importPath.startsWith("@/")) {
        const withoutAlias = importPath.slice(2)

        // Try common locations in order
        const possiblePaths = [
            resolve(workingDir, withoutAlias),           // @/ -> ./
            resolve(workingDir, "src", withoutAlias),    // @/ -> ./src/
        ]

        for (const possiblePath of possiblePaths) {
            // Check if any file exists with common extensions
            const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]
            for (const ext of extensions) {
                if (existsSync(possiblePath + ext)) {
                    return possiblePath
                }
            }
            // Check if it's a directory with index file
            if (existsSync(possiblePath) && existsSync(join(possiblePath, "index.ts"))) {
                return possiblePath
            }
        }

        // Default to project root if nothing found
        return resolve(workingDir, withoutAlias)
    }

    // For other paths (node_modules, etc.), return as-is
    return importPath
}
