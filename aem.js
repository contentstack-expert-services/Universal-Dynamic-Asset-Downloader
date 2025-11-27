#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ============================================
// DYNAMIC CONFIGURATION
// ============================================
const config = {
  baseUrl: process.env.BASE_URL,
  outputDir: process.env.OUTPUT_DIR,
  cookie: process.env.COOKIE, // REQUIRED - Add your cookie here

  // Advanced settings
  downloadMetadata: true,
  downloadRenditions: false, // Set to true if needed
  maxDepth: 50, // Very deep to ensure we get everything
  maxConcurrent: 3,
  sleepTime: 200,
  retryAttempts: 3,
  retryDelay: 1000,
  requestTimeout: 30000,
  testMode: false, // Will be set by command line
  testLimit: 10, // Number of assets to download in test mode
  queryMode: false, // Query mode for specific assets
  queryFile: null, // Path to JSON file with asset paths
  findMode: false, // Find mode for searching assets
  findPattern: null, // Pattern to search for
  findDownloadMode: false, // Find and download mode
  findMultipleMode: false, // Find multiple patterns mode
  findPatterns: [], // Multiple patterns to search for
  findStringMode: false, // Find from single string mode

  // File filtering
  fileTypes: [], // Empty = all types, or ['jpg', 'png', 'pdf']
  minFileSize: 0,
  maxFileSize: 5000000000, // 5GB
  skipPatterns: ['.tmp', '.temp', 'thumb_', 'thumbnail', '.cache', 'cq5dam.thumbnail'],

  // Smart discovery settings
  smartDepthDetection: true,
  maxJsonDepth: 5, // Try up to .5.json
  adaptiveDelay: true, // Automatically adjust delay based on server response

  // Don't change these
  processedPaths: new Set(),
  discoveredAssets: new Map(),
  folderQueue: [],
  stats: {
    startTime: Date.now(),
    foldersScanned: 0,
    totalAssets: 0,
    downloadedAssets: 0,
    skippedAssets: 0,
    failedAssets: 0,
    totalSize: 0,
    errors: []
  }
};

// ============================================
// HTTP CLIENT WITH SMART RETRY
// ============================================

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json,*/*',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Cookie': config.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': config.baseUrl,
        ...options.headers
      },
      timeout: config.requestTimeout
    };

    const req = client.request(requestOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return makeRequest(res.headers.location, options).then(resolve).catch(reject);
      }

      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      if (options.responseType === 'stream') {
        resolve(res);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (options.json === false) {
            resolve(data);
          } else {
            const result = JSON.parse(data);
            resolve(result);
          }
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function makeRequestWithRetry(url, options = {}, attempt = 1) {
  try {
    return await makeRequest(url, options);
  } catch (error) {
    if (attempt < config.retryAttempts) {
      const delay = config.retryDelay * attempt;
      await sleep(delay);
      return makeRequestWithRetry(url, options, attempt + 1);
    }
    throw error;
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const ensureDirectory = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

// ============================================
// QUERY-BASED ASSET FUNCTIONS
// ============================================

/**
 * Load asset paths from JSON file
 */
function loadQueryFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Query file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    let assetPaths = [];
    let baseDAMPath = '/content/dam'; // Default base path

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(content);

      // Check for custom base path in the JSON
      if (parsed.basePath && typeof parsed.basePath === 'string') {
        baseDAMPath = parsed.basePath;
        console.log(`Using custom base path: ${baseDAMPath}`);
      }

      // Handle different JSON structures
      if (Array.isArray(parsed)) {
        assetPaths = parsed;
      } else if (parsed.assets && Array.isArray(parsed.assets)) {
        assetPaths = parsed.assets;
      } else if (parsed.paths && Array.isArray(parsed.paths)) {
        assetPaths = parsed.paths;
      } else {
        // Try to extract array values from object
        assetPaths = Object.values(parsed).flat().filter(item =>
          typeof item === 'string' && (item.startsWith('/content/') || item.startsWith('/'))
        );
      }
    } catch (e) {
      // If not JSON, treat each line as a path
      assetPaths = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && (line.startsWith('/content/') || line.startsWith('/')));
    }

    // Clean and validate paths
    assetPaths = assetPaths
      .map(path => {
        // Clean up the path
        let cleanPath = path.trim();

        // Remove query parameters and fragments
        cleanPath = cleanPath.split('?')[0].split('#')[0];

        // Handle relative paths (don't start with /content/)
        if (!cleanPath.startsWith('/content/')) {
          if (cleanPath.startsWith('/')) {
            // Relative path starting with / - append to base DAM path
            cleanPath = `${baseDAMPath}${cleanPath}`;
          } else {
            // Relative path without leading / - append to base DAM path with /
            cleanPath = `${baseDAMPath}/${cleanPath}`;
          }
        }

        // Handle coreimg paths - extract the actual asset path
        if (cleanPath.includes('.coreimg.')) {
          const parts = cleanPath.split('.coreimg.');
          if (parts.length > 1) {
            // Try to extract the original asset path from the coreimg URL
            const corePart = parts[1];
            if (corePart.includes('/')) {
              const pathParts = corePart.split('/');
              if (pathParts.length > 1) {
                // Reconstruct the asset path
                cleanPath = parts[0]; // Base path
                // Look for timestamp and filename
                const filename = pathParts[pathParts.length - 1];
                if (filename && filename.includes('.')) {
                  cleanPath = `${parts[0]}/${filename}`;
                }
              }
            }
          }
        }

        return cleanPath;
      })
      .filter(path => path && path.startsWith('/content/'))
      .filter((path, index, array) => array.indexOf(path) === index); // Remove duplicates

    console.log(`Loaded ${assetPaths.length} asset paths from ${filePath}`);

    if (baseDAMPath !== '/content/dam') {
      console.log(`Base DAM path: ${baseDAMPath}`);
    }

    if (assetPaths.length > 0) {
      console.log('Sample paths:');
      assetPaths.slice(0, 3).forEach(path => {
        console.log(`   - ${path}`);
      });
      if (assetPaths.length > 3) {
        console.log(`   ... and ${assetPaths.length - 3} more`);
      }
    }

    return assetPaths;
  } catch (error) {
    console.error(`Error loading query file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Create asset info from path
 */
function createAssetInfoFromPath(assetPath) {
  const name = path.basename(assetPath);
  const extension = path.extname(name).toLowerCase().slice(1) || 'unknown';

  return {
    path: assetPath,
    name: name,
    extension: extension,
    mimeType: getMimeType(extension),
    size: 0, // Will be determined during download
    queryBased: true, // Mark as query-based asset
    metadata: {},
    renditions: []
  };
}

/**
 * Process query-based assets
 */
async function processQueryAssets(assetPaths) {
  console.log('\nPROCESSING QUERY-BASED ASSETS');
  console.log('='.repeat(60));

  const assets = [];

  for (const assetPath of assetPaths) {
    try {
      let assetInfo = null;

      // Check if this looks like a simple filename (no path structure)
      const isSimpleFilename = !assetPath.includes('/') ||
        (assetPath.startsWith('/content/dam/') && assetPath.split('/').length <= 4 &&
          assetPath.includes('.'));

      if (isSimpleFilename) {
        console.log(`Searching for filename: ${path.basename(assetPath)}`);

        // Search for the asset in the DAM
        const filename = path.basename(assetPath);

        // Reset search state for this search
        config.processedPaths.clear();
        config.folderQueue = [];

        const foundAssets = await findAssets(filename.toLowerCase());

        if (foundAssets.length > 0) {
          console.log(`Found ${foundAssets.length} matches for: ${filename}`);
          // Use the first match with the actual DAM path
          assetInfo = foundAssets[0];
          console.log(`Using asset at: ${assetInfo.path}`);
        } else {
          console.log(`No matches found for: ${filename} - trying as direct path`);
          // Fall back to treating as direct path
          assetInfo = createAssetInfoFromPath(assetPath);
        }
      } else {
        // Try to get metadata if it's a full path
        const metadataUrl = `${config.baseUrl}${assetPath}.json`;
        let assetData = null;

        try {
          assetData = await makeRequestWithRetry(metadataUrl);
          console.log(`Found metadata for: ${path.basename(assetPath)}`);
        } catch (error) {
          console.log(`No metadata found for: ${path.basename(assetPath)} - searching DAM`);

          // If direct metadata fetch fails, search for the filename
          const filename = path.basename(assetPath);

          // Reset search state for this search
          config.processedPaths.clear();
          config.folderQueue = [];

          const foundAssets = await findAssets(filename.toLowerCase());

          if (foundAssets.length > 0) {
            console.log(`Found ${foundAssets.length} matches for: ${filename}`);
            assetInfo = foundAssets[0];
            console.log(`Using asset at: ${assetInfo.path}`);
          }
        }

        if (!assetInfo) {
          if (assetData && typeof assetData === 'object') {
            // Extract info from metadata
            assetInfo = extractAssetInfo(assetData, assetPath);
          } else {
            // Create basic info from path
            assetInfo = createAssetInfoFromPath(assetPath);
          }
        }
      }

      if (assetInfo && isValidAsset(assetInfo)) {
        assets.push(assetInfo);
        config.stats.totalAssets++;
      } else {
        console.log(`Skipped invalid asset: ${assetPath}`);
        config.stats.skippedAssets++;
      }
    } catch (error) {
      console.log(`Error processing ${assetPath}: ${error.message}`);
      config.stats.errors.push({
        asset: assetPath,
        error: error.message
      });
    }

    // Small delay to be nice to the server
    await sleep(config.sleepTime);
  }

  console.log(`\nQuery processing complete: ${assets.length} valid assets found`);
  return assets;
}

// ============================================
// FIND/SEARCH FUNCTIONALITY
// ============================================

/**
 * Find assets matching a pattern in the DAM
 */
async function findAssets(pattern) {
  console.log('\nSEARCHING FOR ASSETS');
  console.log('='.repeat(60));
  console.log(`Search pattern: "${pattern}"`);

  // Normalize the pattern
  const searchPattern = pattern.toLowerCase();
  const foundAssets = [];
  const searchResults = new Map();

  // Start discovery but track matches
  config.folderQueue.push('/content/dam');

  while (config.folderQueue.length > 0) {
    const currentPath = config.folderQueue.shift();

    if (config.processedPaths.has(currentPath)) continue;
    config.processedPaths.add(currentPath);

    const matches = await searchInFolder(currentPath, searchPattern);
    matches.forEach(match => {
      if (!searchResults.has(match.path)) {
        searchResults.set(match.path, match);
        foundAssets.push(match);
        console.log(`Found: ${match.path}`);
        console.log(`   Name: ${match.name}`);
        console.log(`   Size: ${match.size ? formatBytes(match.size) : 'Unknown'}`);
        console.log(`   Match: ${match.matchReason}\n`);
      }
    });

    // Add small delay to be nice to server
    if (config.stats.foldersScanned % 5 === 0) {
      await sleep(config.sleepTime);
    }
  }

  console.log('='.repeat(60));
  console.log(`SEARCH COMPLETE: Found ${foundAssets.length} matching assets`);
  console.log('='.repeat(60) + '\n');

  if (foundAssets.length === 0) {
    console.log('Search tips:');
    console.log('- Try a shorter pattern (e.g., "icon2" instead of "icon2-returns")');
    console.log('- Use filename only (e.g., "returns.png")');
    console.log('- Try partial timestamp (e.g., "1683123")');
    console.log('- Check if the asset exists in a different location');
  }

  return foundAssets;
}

/**
 * Find assets from a single string containing patterns or filenames
 */
async function findFromString(searchString) {
  console.log('\nSEARCHING FROM STRING');
  console.log('='.repeat(60));
  console.log(`Search string: "${searchString}"`);

  // Parse the string - could be comma-separated patterns or a single filename
  let patterns = [];

  // Check if it looks like a filename (has extension)
  if (searchString.includes('.') && !searchString.includes(',')) {
    patterns = [searchString.trim()];
  } else {
    // Split by comma and clean up
    patterns = searchString.split(',').map(p => p.trim()).filter(p => p);
  }

  console.log(`Parsed into patterns: ${patterns.map(p => `"${p}"`).join(', ')}`);

  if (patterns.length === 1) {
    // Use single pattern search for one pattern
    return await findAssets(patterns[0]);
  } else if (patterns.length > 1) {
    // Use multiple pattern search for multiple patterns
    return await findMultipleAssets(patterns);
  } else {
    console.log('No valid patterns found in string');
    return [];
  }
}
async function findMultipleAssets(patterns) {
  console.log('\nSEARCHING FOR MULTIPLE PATTERNS');
  console.log('='.repeat(60));
  console.log(`Search patterns: ${patterns.map(p => `"${p}"`).join(', ')}`);

  // Normalize the patterns
  const searchPatterns = patterns.map(pattern => pattern.toLowerCase());
  const foundAssets = [];
  const searchResults = new Map();

  // Start discovery but track matches
  config.folderQueue.push('/content/dam');

  while (config.folderQueue.length > 0) {
    const currentPath = config.folderQueue.shift();

    if (config.processedPaths.has(currentPath)) continue;
    config.processedPaths.add(currentPath);

    const matches = await searchInFolderMultiple(currentPath, searchPatterns);
    matches.forEach(match => {
      if (!searchResults.has(match.path)) {
        searchResults.set(match.path, match);
        foundAssets.push(match);
        console.log(`Found: ${match.path}`);
        console.log(`   Name: ${match.name}`);
        console.log(`   Size: ${match.size ? formatBytes(match.size) : 'Unknown'}`);
        console.log(`   Match: ${match.matchReason} (pattern: "${match.matchedPattern}")\n`);
      }
    });

    // Add small delay to be nice to server
    if (config.stats.foldersScanned % 5 === 0) {
      await sleep(config.sleepTime);
    }
  }

  console.log('='.repeat(60));
  console.log(`SEARCH COMPLETE: Found ${foundAssets.length} matching assets`);
  console.log('='.repeat(60) + '\n');

  if (foundAssets.length === 0) {
    console.log('Search tips:');
    console.log('- Try shorter patterns');
    console.log('- Use filename only instead of full paths');
    console.log('- Try partial timestamps or identifiers');
    console.log('- Check if the assets exist in different locations');
  } else {
    // Show summary by pattern
    console.log('Results by pattern:');
    patterns.forEach(pattern => {
      const matches = foundAssets.filter(asset =>
        asset.matchedPattern && asset.matchedPattern.toLowerCase() === pattern.toLowerCase()
      );
      console.log(`   "${pattern}": ${matches.length} matches`);
    });
  }

  return foundAssets;
}

/**
 * Search for pattern matches in a specific folder
 */
async function searchInFolder(folderPath, pattern) {
  config.stats.foldersScanned++;

  const jsonDepths = ['.1.json', '.json', '.2.json', '.3.json'];
  let bestData = null;

  for (const jsonDepth of jsonDepths) {
    try {
      const url = `${config.baseUrl}${folderPath}${jsonDepth}`;
      const data = await makeRequestWithRetry(url);

      if (data && typeof data === 'object') {
        bestData = data;
        break; // Use first successful response
      }
    } catch (error) {
      // Silent fail, try next depth
    }
  }

  if (!bestData) {
    return [];
  }

  console.log(`Searching in: ${folderPath}`);
  return await searchInDAMData(bestData, folderPath, pattern);
}

/**
 * Search for pattern matches in a specific folder (multiple patterns)
 */
async function searchInFolderMultiple(folderPath, patterns) {
  config.stats.foldersScanned++;

  const jsonDepths = ['.1.json', '.json', '.2.json', '.3.json'];
  let bestData = null;

  for (const jsonDepth of jsonDepths) {
    try {
      const url = `${config.baseUrl}${folderPath}${jsonDepth}`;
      const data = await makeRequestWithRetry(url);

      if (data && typeof data === 'object') {
        bestData = data;
        break; // Use first successful response
      }
    } catch (error) {
      // Silent fail, try next depth
    }
  }

  if (!bestData) {
    return [];
  }

  console.log(`Searching in: ${folderPath}`);
  return await searchInDAMDataMultiple(bestData, folderPath, patterns);
}

/**
 * Search through DAM data for pattern matches
 */
async function searchInDAMData(data, basePath, pattern) {
  if (!data || typeof data !== 'object') return [];

  const matches = [];

  for (const key in data) {
    if (key.startsWith('jcr:') || key.startsWith(':') ||
      key === 'rep:policy' || key === 'cq:conf') continue;

    const item = data[key];
    if (!item || typeof item !== 'object') continue;

    const itemPath = item['jcr:path'] || `${basePath}/${key}`;
    const primaryType = item['jcr:primaryType'];

    // Check if it's an asset
    if (isAsset(item, primaryType)) {
      const assetInfo = extractAssetInfo(item, itemPath);
      if (assetInfo) {
        const matchReason = checkPatternMatch(assetInfo, pattern);
        if (matchReason) {
          assetInfo.matchReason = matchReason;
          matches.push(assetInfo);
        }
      }
    }

    // If it's a folder, add to queue for further searching
    if (isFolder(primaryType)) {
      if (!config.processedPaths.has(itemPath)) {
        config.folderQueue.push(itemPath);
      }

      // Also search nested data if present
      const nestedMatches = await searchInDAMData(item, itemPath, pattern);
      matches.push(...nestedMatches);
    }
  }

  return matches;
}

/**
 * Search through DAM data for multiple pattern matches
 */
async function searchInDAMDataMultiple(data, basePath, patterns) {
  if (!data || typeof data !== 'object') return [];

  const matches = [];

  for (const key in data) {
    if (key.startsWith('jcr:') || key.startsWith(':') ||
      key === 'rep:policy' || key === 'cq:conf') continue;

    const item = data[key];
    if (!item || typeof item !== 'object') continue;

    const itemPath = item['jcr:path'] || `${basePath}/${key}`;
    const primaryType = item['jcr:primaryType'];

    // Check if it's an asset
    if (isAsset(item, primaryType)) {
      const assetInfo = extractAssetInfo(item, itemPath);
      if (assetInfo) {
        // Check against all patterns
        for (const pattern of patterns) {
          const matchResult = checkPatternMatch(assetInfo, pattern);
          if (matchResult) {
            assetInfo.matchReason = matchResult;
            assetInfo.matchedPattern = pattern;
            matches.push(assetInfo);
            break; // Don't match the same asset multiple times
          }
        }
      }
    }

    // If it's a folder, add to queue for further searching
    if (isFolder(primaryType)) {
      if (!config.processedPaths.has(itemPath)) {
        config.folderQueue.push(itemPath);
      }

      // Also search nested data if present
      const nestedMatches = await searchInDAMDataMultiple(item, itemPath, patterns);
      matches.push(...nestedMatches);
    }
  }

  return matches;
}

/**
 * Check if an asset matches the search pattern
 */
function checkPatternMatch(assetInfo, pattern) {
  const checks = [
    {
      value: assetInfo.path.toLowerCase(),
      reason: 'Full path match'
    },
    {
      value: assetInfo.name.toLowerCase(),
      reason: 'Filename match'
    },
    {
      value: path.basename(assetInfo.path, path.extname(assetInfo.path)).toLowerCase(),
      reason: 'Filename without extension match'
    }
  ];

  // Add metadata checks if available
  if (assetInfo.title) {
    checks.push({
      value: assetInfo.title.toLowerCase(),
      reason: 'Title match'
    });
  }

  if (assetInfo.description) {
    checks.push({
      value: assetInfo.description.toLowerCase(),
      reason: 'Description match'
    });
  }

  if (assetInfo.keywords) {
    checks.push({
      value: String(assetInfo.keywords).toLowerCase(),
      reason: 'Keywords match'
    });
  }

  // Check for matches
  for (const check of checks) {
    if (check.value.includes(pattern)) {
      return check.reason;
    }
  }

  // Check for partial path segments
  const pathSegments = assetInfo.path.toLowerCase().split('/');
  for (const segment of pathSegments) {
    if (segment.includes(pattern)) {
      return 'Path segment match';
    }
  }

  return null;
}

/**
 * Generate search results file
 */
function saveSearchResults(pattern, foundAssets) {
  if (foundAssets.length === 0) return;

  const searchReport = {
    search: {
      pattern: pattern,
      timestamp: new Date().toISOString(),
      resultsCount: foundAssets.length,
      baseUrl: config.baseUrl
    },
    results: foundAssets.map(asset => ({
      path: asset.path,
      name: asset.name,
      size: asset.size,
      sizeFormatted: formatBytes(asset.size || 0),
      extension: asset.extension,
      mimeType: asset.mimeType,
      matchReason: asset.matchReason,
      matchedPattern: asset.matchedPattern,
      downloadUrl: `${config.baseUrl}${asset.path}`,
      // Include key metadata if available
      title: asset.title,
      created: asset.created,
      modified: asset.modified
    }))
  };

  ensureDirectory(config.outputDir);
  const reportPath = path.join(config.outputDir, `search-results-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(searchReport, null, 2));

  console.log(`Search results saved to: ${reportPath}`);

  // Also create a simple paths-only file for easy query use
  const pathsOnly = foundAssets.map(asset => asset.path);
  const pathsPath = path.join(config.outputDir, `search-paths-${Date.now()}.json`);
  fs.writeFileSync(pathsPath, JSON.stringify({ assets: pathsOnly }, null, 2));

  console.log(`Asset paths saved to: ${pathsPath}`);
  console.log(`Use with: node aem.js --query ${path.basename(pathsPath)}`);
}

// ============================================
// INTELLIGENT DAM DISCOVERY
// ============================================

/**
 * Main discovery function - finds all assets in entire DAM
 */
async function discoverAllAssets() {
  console.log('\nStarting Intelligent DAM Discovery...\n');
  console.log('='.repeat(60));

  // Start with root
  config.folderQueue.push('/content/dam');

  while (config.folderQueue.length > 0) {
    const currentPath = config.folderQueue.shift();

    // Skip if already processed
    if (config.processedPaths.has(currentPath)) continue;
    config.processedPaths.add(currentPath);

    await scanFolder(currentPath);

    // In test mode, stop early if we have enough assets
    if (config.testMode && config.stats.totalAssets >= config.testLimit) {
      console.log(`\nTest mode: Stopping discovery after finding ${config.stats.totalAssets} assets`);
      break;
    }

    // Adaptive delay
    if (config.adaptiveDelay && config.stats.foldersScanned % 10 === 0) {
      await sleep(config.sleepTime);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Discovery Complete: Found ${config.stats.totalAssets} total assets`);
  console.log(`Scanned ${config.stats.foldersScanned} folders`);
  if (config.testMode) {
    console.log(`TEST MODE: Limited to ${config.testLimit} assets`);
  }
  console.log('='.repeat(60) + '\n');

  // In test mode, return only the first N assets
  const allAssets = Array.from(config.discoveredAssets.values());
  if (config.testMode) {
    return allAssets.slice(0, config.testLimit);
  }
  return allAssets;
}

/**
 * Scan a single folder for assets and subfolders
 */
async function scanFolder(folderPath, depth = 0) {
  if (depth > config.maxDepth) return;

  config.stats.foldersScanned++;

  // Try different JSON depths to find the best one
  const jsonDepths = config.smartDepthDetection
    ? ['.1.json', '.json', '.2.json', '.3.json', '.4.json', '.5.json']
    : ['.1.json', '.json'];

  let bestData = null;
  let bestDepth = null;
  let maxItems = 0;

  for (const jsonDepth of jsonDepths) {
    try {
      const url = `${config.baseUrl}${folderPath}${jsonDepth}`;
      const data = await makeRequestWithRetry(url);

      if (data && typeof data === 'object') {
        const itemCount = Object.keys(data).filter(k => !k.startsWith('jcr:') && !k.startsWith(':')).length;

        // Use the depth that returns the most items
        if (itemCount > maxItems) {
          maxItems = itemCount;
          bestData = data;
          bestDepth = jsonDepth;

          // If we get a lot of items, don't try deeper
          if (itemCount > 50) break;
        }
      }
    } catch (error) {
      // Silent fail, try next depth
    }
  }

  if (!bestData) {
    return;
  }

  console.log(`Scanning: ${folderPath} (depth: ${depth}, format: ${bestDepth}, items: ${maxItems})`);

  // Process the data
  await processDAMData(bestData, folderPath, depth);
}

/**
 * Process DAM JSON data to extract assets and folders
 */
async function processDAMData(data, basePath, currentDepth) {
  if (!data || typeof data !== 'object') return;

  let localAssets = 0;
  let localFolders = 0;

  for (const key in data) {
    // Skip system properties
    if (key.startsWith('jcr:') || key.startsWith(':') ||
      key === 'rep:policy' || key === 'cq:conf') continue;

    const item = data[key];
    if (!item || typeof item !== 'object') continue;

    const itemPath = item['jcr:path'] || `${basePath}/${key}`;
    const primaryType = item['jcr:primaryType'];

    // Check if it's an asset
    if (isAsset(item, primaryType)) {
      const assetInfo = extractAssetInfo(item, itemPath);
      if (assetInfo && isValidAsset(assetInfo)) {
        config.discoveredAssets.set(itemPath, assetInfo);
        config.stats.totalAssets++;
        localAssets++;

        // In test mode, stop if we have enough
        if (config.testMode && config.stats.totalAssets >= config.testLimit) {
          console.log(`   Test limit reached (${config.testLimit} assets)`);
          return;
        }
      }
    }

    // Check if it's a folder
    if (isFolder(primaryType)) {
      // Add to queue for processing (unless in test mode and we have enough)
      if (!config.processedPaths.has(itemPath) && currentDepth < config.maxDepth) {
        if (!config.testMode || config.stats.totalAssets < config.testLimit) {
          config.folderQueue.push(itemPath);
          localFolders++;
        }
      }

      // Also recursively process nested data if present
      if (currentDepth < 2 && (!config.testMode || config.stats.totalAssets < config.testLimit)) {
        await processDAMData(item, itemPath, currentDepth + 1);
      }
    }
  }

  if (localAssets > 0 || localFolders > 0) {
    console.log(`   Found: ${localAssets} assets, ${localFolders} subfolders`);
  }
}

/**
 * Check if an item is an asset
 */
function isAsset(item, primaryType) {
  // Multiple ways to detect an asset
  if (primaryType === 'dam:Asset') return true;
  if (primaryType === 'dam:AssetContent') return true;
  if (item['jcr:content'] && item['jcr:content']['renditions']) return true;
  if (item['jcr:content'] && item['jcr:content']['metadata']) {
    const metadata = item['jcr:content']['metadata'];
    if (metadata['dam:size'] || metadata['dc:format']) return true;
  }
  return false;
}

/**
 * Check if an item is a folder
 */
function isFolder(primaryType) {
  return primaryType === 'sling:Folder' ||
    primaryType === 'sling:OrderedFolder' ||
    primaryType === 'nt:folder' ||
    primaryType === 'cq:Page' ||
    primaryType === 'sling:Folder/nt:folder';
}

/**
 * Extract comprehensive asset information
 */
function extractAssetInfo(assetNode, assetPath) {
  try {
    // Multiple possible locations for metadata
    const jcrContent = assetNode['jcr:content'] || assetNode;

    // Try different metadata locations
    const metadata = jcrContent['metadata'] ||
      jcrContent['jcr:content']?.metadata ||
      assetNode['metadata'] ||
      {};

    // Merge all metadata from different sources
    const allMetadata = {};

    // Get metadata from main node
    Object.keys(assetNode).forEach(key => {
      if (!key.startsWith('jcr:') && key !== 'jcr:content' && typeof assetNode[key] !== 'object') {
        allMetadata[key] = assetNode[key];
      }
    });

    // Get metadata from jcr:content
    if (jcrContent && jcrContent !== assetNode) {
      Object.keys(jcrContent).forEach(key => {
        if (!key.startsWith('jcr:') && key !== 'metadata' && key !== 'renditions' && typeof jcrContent[key] !== 'object') {
          allMetadata[key] = jcrContent[key];
        }
      });
    }

    // Get metadata from metadata node
    Object.keys(metadata).forEach(key => {
      allMetadata[key] = metadata[key];
    });

    // Get renditions
    const renditions = jcrContent['renditions'] ||
      assetNode['renditions'] ||
      {};

    const name = path.basename(assetPath);
    const extension = path.extname(name).toLowerCase().slice(1) || 'unknown';

    // Build download URL
    const downloadPath = assetPath.startsWith('/') ? assetPath : '/' + assetPath;

    // Extract all possible metadata fields
    const assetInfo = {
      path: downloadPath,
      name: name,
      extension: extension,
      mimeType: allMetadata['dc:format'] ||
        jcrContent['jcr:mimeType'] ||
        allMetadata['jcr:mimeType'] ||
        getMimeType(extension),
      size: parseInt(allMetadata['dam:size']) ||
        parseInt(jcrContent['dam:size']) ||
        parseInt(allMetadata['dam:Filedata.sizeOnDisk']) ||
        0,

      // Image metadata
      width: allMetadata['tiff:ImageWidth'] ||
        allMetadata['exif:PixelXDimension'] ||
        allMetadata['dam:Physicalwidthininches'],
      height: allMetadata['tiff:ImageLength'] ||
        allMetadata['exif:PixelYDimension'] ||
        allMetadata['dam:Physicalheightininches'],

      // Dates
      created: assetNode['jcr:created'] ||
        jcrContent['jcr:created'] ||
        allMetadata['xmp:CreateDate'],
      modified: jcrContent['jcr:lastModified'] ||
        allMetadata['jcr:lastModified'] ||
        allMetadata['xmp:ModifyDate'],

      // Content metadata
      title: allMetadata['dc:title'] ||
        allMetadata['jcr:title'] ||
        name,
      description: allMetadata['dc:description'] ||
        allMetadata['jcr:description'],
      keywords: allMetadata['dc:subject'] ||
        allMetadata['pdf:Keywords'],
      creator: allMetadata['dc:creator'] ||
        allMetadata['xmp:CreatorTool'],

      // Additional metadata
      copyright: allMetadata['dc:rights'] ||
        allMetadata['xmpRights:WebStatement'],
      tags: allMetadata['cq:tags'],
      lastModifiedBy: allMetadata['jcr:lastModifiedBy'] ||
        jcrContent['jcr:lastModifiedBy'],

      // Renditions
      renditions: Object.keys(renditions).filter(r =>
        !r.includes('jcr:') && !r.includes('cq5dam.thumbnail')
      ),

      // Full metadata object
      metadata: allMetadata,

      // Raw data for debugging
      _raw: {
        assetNode: assetNode,
        jcrContent: jcrContent
      }
    };

    // Remove undefined values
    Object.keys(assetInfo).forEach(key => {
      if (assetInfo[key] === undefined && key !== '_raw') {
        delete assetInfo[key];
      }
    });

    return assetInfo;
  } catch (error) {
    console.log(`   Error extracting metadata for ${assetPath}: ${error.message}`);
    return null;
  }
}

/**
 * Validate if an asset should be downloaded
 */
function isValidAsset(assetInfo) {
  // Check file size limits
  if (config.minFileSize > 0 && assetInfo.size < config.minFileSize) return false;
  if (config.maxFileSize > 0 && assetInfo.size > config.maxFileSize) return false;

  // Check file type filter
  if (config.fileTypes.length > 0 && !config.fileTypes.includes(assetInfo.extension)) {
    return false;
  }

  // Skip patterns
  const lowerName = assetInfo.name.toLowerCase();
  if (config.skipPatterns.some(pattern => lowerName.includes(pattern))) {
    return false;
  }

  return true;
}

/**
 * Get MIME type from extension
 */
function getMimeType(ext) {
  const mimes = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip', txt: 'text/plain', html: 'text/html', css: 'text/css',
    js: 'application/javascript', json: 'application/json', xml: 'text/xml'
  };
  return mimes[ext] || 'application/octet-stream';
}

// ============================================
// DOWNLOAD FUNCTIONS
// ============================================

/**
 * Download all discovered assets
 */
async function downloadAllAssets(assets) {
  if (assets.length === 0) {
    console.log('\nNo assets to download');
    return;
  }

  const downloadCount = config.testMode ? Math.min(assets.length, config.testLimit) : assets.length;
  console.log(`\nStarting download of ${downloadCount} assets...`);
  if (config.testMode) {
    console.log(`TEST MODE: Downloading only first ${config.testLimit} assets\n`);
  }
  if (config.queryMode) {
    console.log(`QUERY MODE: Downloading specific assets from query file\n`);
  }
  if (config.findDownloadMode) {
    console.log(`FIND & DOWNLOAD MODE: Searching and downloading assets\n`);
  }
  console.log('='.repeat(60));

  const queue = config.testMode ? assets.slice(0, config.testLimit) : [...assets];
  const inProgress = [];
  let lastProgressUpdate = Date.now();

  while (queue.length > 0 || inProgress.length > 0) {
    // Start new downloads
    while (inProgress.length < config.maxConcurrent && queue.length > 0) {
      const asset = queue.shift();
      const promise = downloadAsset(asset).then(() => {
        const index = inProgress.indexOf(promise);
        if (index > -1) inProgress.splice(index, 1);
      });
      inProgress.push(promise);
    }

    // Wait for at least one to complete
    if (inProgress.length > 0) {
      await Promise.race(inProgress);
    }

    // Update progress
    const now = Date.now();
    if (now - lastProgressUpdate > 1000) {
      const completed = config.stats.downloadedAssets + config.stats.skippedAssets + config.stats.failedAssets;
      const progress = Math.round((completed / downloadCount) * 100);
      process.stdout.write(`\rProgress: ${progress}% | Downloaded: ${config.stats.downloadedAssets} | Skipped: ${config.stats.skippedAssets} | Failed: ${config.stats.failedAssets} | Size: ${formatBytes(config.stats.totalSize)}`);
      lastProgressUpdate = now;
    }

    // Small delay between batches
    if (queue.length > 0 && inProgress.length === config.maxConcurrent) {
      await sleep(config.sleepTime);
    }
  }

  console.log('\n' + '='.repeat(60) + '\n');
}

/**
 * Download a single asset with multiple URL attempts
 */
async function downloadAsset(assetInfo) {
  try {
    // Create output path
    const relativePath = assetInfo.path.replace('/content/dam', '').replace(/^\//, '');
    const outputDir = path.join(config.outputDir, path.dirname(relativePath));
    ensureDirectory(outputDir);

    const outputPath = path.join(config.outputDir, relativePath);

    // Check if already exists
    if (fs.existsSync(outputPath)) {
      const existingSize = fs.statSync(outputPath).size;

      // If we know the expected size, verify it
      if (assetInfo.size > 0 && Math.abs(existingSize - assetInfo.size) < 1000) {
        config.stats.skippedAssets++;
        return true;
      }

      // If file has content, skip
      if (existingSize > 100) {
        config.stats.skippedAssets++;
        return true;
      }
    }

    // Try different URL patterns
    const urlPatterns = [
      `${config.baseUrl}${assetInfo.path}`,
      `${config.baseUrl}${assetInfo.path}/jcr:content/renditions/original`,
      `${config.baseUrl}${assetInfo.path}/_jcr_content/renditions/original`,
      `${config.baseUrl}/content/dam${assetInfo.path}`,
      `${config.baseUrl}${assetInfo.path}?dl=true`
    ];

    let downloaded = false;
    let lastError = null;
    let usedUrl = null;

    for (const url of urlPatterns) {
      try {
        const response = await makeRequestWithRetry(url, { responseType: 'stream' });

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(outputPath);
          response.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
          response.on('error', reject);
        });

        const downloadedSize = fs.statSync(outputPath).size;
        if (downloadedSize > 0) {
          config.stats.downloadedAssets++;
          config.stats.totalSize += downloadedSize;
          downloaded = true;
          usedUrl = url;
          console.log(`\nDownloaded: ${assetInfo.name} (${formatBytes(downloadedSize)})`);
          break;
        }
      } catch (error) {
        lastError = error;
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size === 0) {
          fs.unlinkSync(outputPath);
        }
      }
    }

    if (!downloaded) {
      throw lastError || new Error('All download attempts failed');
    }

    // Save metadata if enabled
    if (config.downloadMetadata) {
      const metadataPath = `${outputPath}.metadata.json`;
      const downloadedSize = fs.statSync(outputPath).size;

      // Create comprehensive metadata object
      const fullMetadata = {
        asset: {
          path: assetInfo.path,
          name: assetInfo.name,
          extension: assetInfo.extension,
          mimeType: assetInfo.mimeType,
          size: assetInfo.size,
          sizeFormatted: formatBytes(assetInfo.size || 0),
          queryBased: assetInfo.queryBased || false
        },
        properties: {
          width: assetInfo.width,
          height: assetInfo.height,
          created: assetInfo.created,
          modified: assetInfo.modified,
          title: assetInfo.title,
          description: assetInfo.description,
          keywords: assetInfo.keywords,
          creator: assetInfo.creator,
          copyright: assetInfo.copyright,
          tags: assetInfo.tags,
          lastModifiedBy: assetInfo.lastModifiedBy
        },
        aem: {
          renditions: assetInfo.renditions,
          originalMetadata: assetInfo.metadata
        },
        download: {
          downloadedAt: new Date().toISOString(),
          downloadedSize: downloadedSize,
          downloadUrl: usedUrl,
          mode: config.queryMode ? 'query' : (config.testMode ? 'test' : (config.findDownloadMode ? 'find' : 'full'))
        }
      };

      // Include raw data if available (for debugging)
      if (assetInfo._raw) {
        fullMetadata._raw = assetInfo._raw;
      }

      fs.writeFileSync(metadataPath, JSON.stringify(fullMetadata, null, 2));
      console.log(`   Metadata saved: ${path.basename(metadataPath)}`);
    }

    // Download renditions if enabled
    if (config.downloadRenditions && assetInfo.renditions?.length > 0) {
      await downloadRenditions(assetInfo, outputDir);
    }

    return true;

  } catch (error) {
    console.log(`\nFailed: ${assetInfo.name} - ${error.message}`);
    config.stats.failedAssets++;
    config.stats.errors.push({
      asset: assetInfo.path,
      error: error.message
    });
    return false;
  }
}

/**
 * Download asset renditions
 */
async function downloadRenditions(assetInfo, outputDir) {
  if (!config.downloadRenditions || !assetInfo.renditions?.length) return;

  const renditionsDir = path.join(outputDir, `${assetInfo.name}.renditions`);

  for (const rendition of assetInfo.renditions) {
    if (rendition === 'original' || rendition.includes('metadata')) continue;

    try {
      const urls = [
        `${config.baseUrl}${assetInfo.path}/jcr:content/renditions/${rendition}`,
        `${config.baseUrl}${assetInfo.path}/_jcr_content/renditions/${rendition}`
      ];

      ensureDirectory(renditionsDir);
      const renditionPath = path.join(renditionsDir, rendition);

      for (const url of urls) {
        try {
          const response = await makeRequestWithRetry(url, { responseType: 'stream' });

          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(renditionPath);
            response.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          if (fs.statSync(renditionPath).size > 0) {
            console.log(`   Rendition saved: ${rendition}`);
            break;
          }
        } catch (e) {
          // Try next URL
        }
      }
    } catch (error) {
      // Silent fail for renditions
    }
  }
}

// ============================================
// REPORTING
// ============================================

function generateReport() {
  const duration = Date.now() - config.stats.startTime;
  const durationMin = Math.floor(duration / 60000);
  const durationSec = Math.floor((duration % 60000) / 1000);

  let reportSuffix = 'download-report.json';
  let status = 'Complete';
  let mode = 'full';

  if (config.queryMode) {
    reportSuffix = 'query-report.json';
    status = 'Query Complete';
    mode = 'query';
  } else if (config.findDownloadMode) {
    reportSuffix = 'find-download-report.json';
    status = 'Find & Download Complete';
    mode = 'find-download';
  } else if (config.testMode) {
    reportSuffix = 'test-report.json';
    status = 'Test Complete';
    mode = 'test';
  }

  const report = {
    summary: {
      status: status,
      mode: mode,
      queryMode: config.queryMode,
      findMode: config.findMode,
      findDownloadMode: config.findDownloadMode,
      findMultipleMode: config.findMultipleMode,
      testMode: config.testMode,
      queryFile: config.queryFile,
      findPattern: config.findPattern,
      findPatterns: config.findPatterns,
      baseUrl: config.baseUrl,
      outputDirectory: path.resolve(config.outputDir),
      foldersScanned: config.stats.foldersScanned,
      totalAssetsFound: config.stats.totalAssets,
      downloadedAssets: config.stats.downloadedAssets,
      skippedAssets: config.stats.skippedAssets,
      failedAssets: config.stats.failedAssets,
      totalSize: formatBytes(config.stats.totalSize),
      duration: `${durationMin}m ${durationSec}s`,
      timestamp: new Date().toISOString()
    },
    errors: config.stats.errors
  };

  const reportPath = path.join(config.outputDir, reportSuffix);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("DOWNLOAD COMPLETE");
  console.log("=".repeat(60));

  if (config.queryMode) {
    console.log(`Query File: ${config.queryFile}`);
  }
  if (config.findDownloadMode) {
    const patterns = config.findMultipleMode ?
      config.findPatterns.join(', ') :
      config.findPattern;
    console.log(`Search Pattern(s): ${patterns}`);
  }
  if (!config.queryMode && !config.findDownloadMode) {
    console.log(`Folders Scanned: ${config.stats.foldersScanned}`);
  }

  console.log(`Assets Found: ${config.stats.totalAssets}`);
  console.log(`Downloaded: ${config.stats.downloadedAssets} assets`);
  console.log(`Skipped: ${config.stats.skippedAssets} assets`);
  console.log(`Failed: ${config.stats.failedAssets} assets`);
  console.log(`Total Size: ${formatBytes(config.stats.totalSize)}`);
  console.log(`Duration: ${durationMin}m ${durationSec}s`);
  console.log(`Report: ${reportPath}`);

  if (config.testMode) {
    console.log(`\nThis was a TEST RUN - limited to ${config.testLimit} assets`);
    console.log(`   Run without --test-10 to download all ${config.stats.totalAssets} assets`);
  }
  if (config.queryMode) {
    console.log(`\nThis was a QUERY-BASED download from: ${config.queryFile}`);
  }
  if (config.findDownloadMode) {
    console.log(`\nThis was a FIND & DOWNLOAD operation`);
  }

  console.log("=".repeat(60));

  if (config.stats.errors.length > 0) {
    console.log("\nFailed downloads:");
    config.stats.errors.slice(0, 5).forEach(e => {
      console.log(`   - ${e.asset}: ${e.error}`);
    });
    if (config.stats.errors.length > 5) {
      console.log(`   ... and ${config.stats.errors.length - 5} more (see report)`);
    }
  }
}

// ============================================
// MAIN EXECUTION
// ============================================

async function main() {
  console.log("=".repeat(60));
  console.log("AEM UNIVERSAL DYNAMIC ASSET DOWNLOADER v3.3");

  if (config.findDownloadMode && config.findStringMode) {
    console.log("FIND STRING & DOWNLOAD MODE - Search from string and download");
  } else if (config.findDownloadMode && config.findMultipleMode) {
    console.log("FIND MULTIPLE & DOWNLOAD MODE - Search multiple patterns and download");
  } else if (config.findDownloadMode) {
    console.log("FIND & DOWNLOAD MODE - Search and download assets");
  } else if (config.findStringMode) {
    console.log("FIND STRING MODE - Search from string pattern");
  } else if (config.findMultipleMode) {
    console.log("FIND MULTIPLE MODE - Search multiple patterns");
  } else if (config.findMode) {
    console.log("FIND MODE - Searching for assets");
  } else if (config.queryMode) {
    console.log("QUERY MODE - Downloading specific assets");
  } else if (config.testMode) {
    console.log("TEST MODE - Will download only 10 assets");
  }

  console.log("=".repeat(60));
  console.log(`Server: ${config.baseUrl}`);
  console.log(`Output: ${config.outputDir}`);

  if (config.queryFile) {
    console.log(`Query File: ${config.queryFile}`);
  }
  if (config.findPattern) {
    console.log(`Search Pattern: ${config.findPattern}`);
  }
  if (config.findPatterns.length > 0) {
    console.log(`Search Patterns: ${config.findPatterns.join(', ')}`);
  }

  console.log("=".repeat(60));

  // Validate cookie
  if (!config.cookie) {
    console.error('\nERROR: Cookie is required for authentication');
    console.log('\nSet your cookie in one of these ways:');
    console.log('1. Edit the script and add it to config.cookie');
    console.log('2. Set COOKIE environment variable');
    console.log('\nExample:');
    console.log('COOKIE="your-cookie-here" node script.js\n');
    process.exit(1);
  }

  // Test connection
  console.log('\nTesting connection...');
  try {
    const testUrl = `${config.baseUrl}/content/dam.json`;
    await makeRequestWithRetry(testUrl);
    console.log('Connection successful!\n');
  } catch (error) {
    console.error('Connection failed:', error.message);
    console.log('\nPossible issues:');
    console.log('- Cookie might be expired');
    console.log('- Base URL might be incorrect');
    console.log('- No access to DAM');
    process.exit(1);
  }

  // Create output directory
  ensureDirectory(config.outputDir);

  // Save config (without sensitive data)
  const configCopy = {
    ...config,
    cookie: '***REDACTED***',
    processedPaths: undefined,
    discoveredAssets: undefined
  };

  let configSuffix = 'config.json';
  if (config.queryMode) configSuffix = 'query-config.json';
  else if (config.findDownloadMode) configSuffix = 'find-download-config.json';
  else if (config.testMode) configSuffix = 'test-config.json';

  fs.writeFileSync(
    path.join(config.outputDir, configSuffix),
    JSON.stringify(configCopy, null, 2)
  );

  try {
    let assets = [];

    if (config.findMode || config.findMultipleMode || config.findStringMode) {
      // Find mode: search for assets matching pattern(s)
      let foundAssets;

      if (config.findStringMode) {
        foundAssets = await findFromString(config.findPattern);
      } else if (config.findMultipleMode) {
        foundAssets = await findMultipleAssets(config.findPatterns);
      } else {
        foundAssets = await findAssets(config.findPattern);
      }

      if (foundAssets.length === 0) {
        let patternText;
        if (config.findStringMode) {
          patternText = `string: "${config.findPattern}"`;
        } else if (config.findMultipleMode) {
          patternText = `patterns: ${config.findPatterns.map(p => `"${p}"`).join(', ')}`;
        } else {
          patternText = `pattern: "${config.findPattern}"`;
        }
        console.log(`\nNo assets found matching ${patternText}`);
        process.exit(0);
      }

      if (config.findDownloadMode) {
        // Convert found assets to download array and proceed with download
        console.log(`\nFound ${foundAssets.length} assets. Proceeding with download...`);
        assets = foundAssets;

        // Update stats for consistency
        config.stats.totalAssets = foundAssets.length;
      } else {
        // Save search results only (original find behavior)
        let searchPattern;
        if (config.findStringMode) {
          searchPattern = config.findPattern;
        } else if (config.findMultipleMode) {
          searchPattern = config.findPatterns.join(',');
        } else {
          searchPattern = config.findPattern;
        }

        saveSearchResults(searchPattern, foundAssets);

        // Ask user if they want to download the found assets
        console.log(`\nFound ${foundAssets.length} assets. Do you want to download them?`);
        console.log('   Run the command again with --query and the generated paths file to download.');
        console.log('   Or use --find-download, --find-multiple-download, or --find-string-download to search and download in one step.');
        process.exit(0);
      }

    } else if (config.queryMode) {
      // Query-based mode: load assets from file
      const assetPaths = loadQueryFile(config.queryFile);
      assets = await processQueryAssets(assetPaths);
    } else {
      // Discovery mode: scan DAM
      console.log('\nPHASE 1: DISCOVERING ASSETS');
      console.log('='.repeat(60));
      assets = await discoverAllAssets();
    }

    if (assets.length === 0) {
      console.log('\nNo assets found');
      if (config.queryMode) {
        console.log('\nPossible reasons:');
        console.log('- Query file might be empty or invalid');
        console.log('- Asset paths in query file might not exist');
        console.log('- Cookie might not have sufficient permissions');
      } else {
        console.log('\nPossible reasons:');
        console.log('- DAM might be empty');
        console.log('- Cookie might not have sufficient permissions');
        console.log('- Different DAM structure than expected');
      }
      process.exit(0);
    }

    if (assets.length > 0) {
      // Phase 2: Download assets
      console.log(`\nPHASE 2: DOWNLOADING ASSETS`);
      console.log('='.repeat(60));
      await downloadAllAssets(assets);
    }

  } catch (error) {
    console.error('\nFatal error:', error);
    config.stats.errors.push({ error: error.message });
  }

  // Generate final report
  generateReport();
}

// ============================================
// ERROR HANDLING
// ============================================

process.on('SIGINT', () => {
  console.log('\n\nDownload interrupted by user');
  generateReport();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('\nUnhandled error:', error);
  generateReport();
  process.exit(1);
});

// ============================================
// ENTRY POINT
// ============================================

if (require.main === module) {
  // Check for command line arguments
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
AEM Universal Dynamic Asset Downloader v3.3
============================================

Usage: node script.js [options]

Options:
  --help, -h         Show this help message
  --test, -t         Test connection only
  --test-10          Download only 10 assets for testing
  --test-limit <n>   Download only N assets for testing
  --query <file>     Download specific assets from JSON file
  --find <pattern>   Search for assets matching pattern (no download)
                     Example: --find "icon2-returns.png"
                     Example: --find "1683123905658"
  --find-download <pattern>  Search for assets and download them immediately
                     Example: --find-download "icon2-returns.png"
                     Example: --find-download "1683123905658"
  --find-multiple <patterns>  Search for multiple patterns (comma-separated)
                     Example: --find-multiple "icon2,perks,logo"
                     Example: --find-multiple "1683123,1679944,returns"
  --find-multiple-download <patterns>  Search multiple patterns and download
                     Example: --find-multiple-download "icon2,perks,logo"
  --find-string <string>  Search from a single string (filename or comma-separated patterns)
                     Example: --find-string "burton.jpeg"
                     Example: --find-string "icon2,perks,logo"
  --find-string-download <string>  Search from string and download immediately
                     Example: --find-string-download "burton.jpeg"
                     Example: --find-string-download "icon2,perks,logo"
  --types <list>     Download only specific file types (comma-separated)
                     Example: --types jpg,png,pdf
  --folder <path>    Start from specific folder (discovery mode only)
                     Example: --folder /content/dam/projects
  --no-renditions    Skip downloading renditions
  --no-metadata      Skip saving metadata

Environment Variables:
  COOKIE             Your AEM session cookie (required)
  BASE_URL           AEM instance URL
  OUTPUT_DIR         Output directory (default: ./dam-downloads)

Examples:
  # Test connection
  COOKIE="your-cookie" node script.js --test
  
  # Test download with 10 assets
  COOKIE="your-cookie" node script.js --test-10
  
  # Download specific assets from JSON file
  COOKIE="your-cookie" node script.js --query assets.json
  
  # Search for assets (no download, just find)
  COOKIE="your-cookie" node script.js --find "icon2-returns.png"
  COOKIE="your-cookie" node script.js --find "1683123905658"
  
  # Search from single string (filename)
  COOKIE="your-cookie" node script.js --find-string "burton.jpeg"
  
  # Search from single string (multiple patterns)
  COOKIE="your-cookie" node script.js --find-string "icon2,perks,logo"
  
  # Search from string AND download immediately
  COOKIE="your-cookie" node script.js --find-string-download "burton.jpeg"
  COOKIE="your-cookie" node script.js --find-string-download "icon2,perks,logo"
  
  # Search multiple patterns (no download)
  COOKIE="your-cookie" node script.js --find-multiple "icon2,perks,logo"
  
  # Search multiple patterns AND download immediately
  COOKIE="your-cookie" node script.js --find-multiple-download "icon2,perks,returns"
  
  # Full DAM discovery and download
  COOKIE="your-cookie" node script.js
  
  # Download only images
  COOKIE="your-cookie" node script.js --types jpg,png,gif
  
  # Start discovery from specific folder
  COOKIE="your-cookie" node script.js --folder /content/dam/my-project

Query File Format:
  The query file can be JSON in various formats:
  
  1. Simple array with full paths:
     ["/content/dam/path/to/asset1.jpg", "/content/dam/path/to/asset2.png"]
  
  2. Simple array with relative paths:
     ["/1683123905658/icon2-returns.png", "/1679944936835/logo.png"]
     (These will be prefixed with /content/dam automatically)
  
  3. Object with assets array:
     {"assets": ["/content/dam/path/to/asset1.jpg"]}
  
  4. Object with relative paths and custom base:
     {
       "basePath": "/content/dam/my-project",
       "assets": ["/icons/icon1.png", "/images/logo.jpg"]
     }
  
  5. Object with paths array:
     {"paths": ["/content/dam/path/to/asset1.jpg"]}
  
  6. Plain text (one path per line):
     /content/dam/path/to/asset1.jpg
     /content/dam/path/to/asset2.png
  
  The script handles:
  - Full AEM paths (/content/dam/...)
  - Relative paths (will be prefixed with /content/dam or custom basePath)
  - Coreimg URLs (extracts asset paths automatically)
  - Custom base paths for relative path resolution

Features:
  - Smart DAM discovery with adaptive depth detection
  - Multiple search patterns support
  - Query-based downloads from JSON files
  - Comprehensive metadata extraction and saving
  - Multiple download URL attempts for reliability
  - Progress tracking and detailed reporting
  - File type filtering and size limits
  - Concurrent downloads with rate limiting
  - Automatic retry with exponential backoff
  - Support for AEM renditions
  - Handles coreimg URLs and complex AEM paths
`);
    process.exit(0);
  }

  if (args.includes('--test') || args.includes('-t')) {
    config.cookie = config.cookie || process.env.COOKIE;
    if (!config.cookie) {
      console.error('Cookie required for test');
      process.exit(1);
    }

    console.log('Testing connection...');
    makeRequestWithRetry(`${config.baseUrl}/content/dam.json`)
      .then(() => {
        console.log('Connection successful!');
        process.exit(0);
      })
      .catch((error) => {
        console.error('Connection failed:', error.message);
        process.exit(1);
      });
    return;
  }

  // Parse command line options
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--test-10') {
      config.testMode = true;
      config.testLimit = 10;
    } else if (args[i] === '--test-limit' && args[i + 1]) {
      config.testMode = true;
      config.testLimit = parseInt(args[i + 1]) || 10;
      i++;
    } else if (args[i] === '--query' && args[i + 1]) {
      config.queryMode = true;
      config.queryFile = args[i + 1];
      i++;
    } else if (args[i] === '--find' && args[i + 1]) {
      config.findMode = true;
      config.findPattern = args[i + 1];
      i++;
    } else if (args[i] === '--find-download' && args[i + 1]) {
      config.findMode = true;
      config.findDownloadMode = true;
      config.findPattern = args[i + 1];
      i++;
    } else if (args[i] === '--find-multiple' && args[i + 1]) {
      config.findMode = true;
      config.findMultipleMode = true;
      config.findPatterns = args[i + 1].split(',').map(p => p.trim());
      i++;
    } else if (args[i] === '--find-multiple-download' && args[i + 1]) {
      config.findMode = true;
      config.findMultipleMode = true;
      config.findDownloadMode = true;
      config.findPatterns = args[i + 1].split(',').map(p => p.trim());
      i++;
    } else if (args[i] === '--find-string' && args[i + 1]) {
      config.findMode = true;
      config.findStringMode = true;
      config.findPattern = args[i + 1];
      i++;
    } else if (args[i] === '--find-string-download' && args[i + 1]) {
      config.findMode = true;
      config.findStringMode = true;
      config.findDownloadMode = true;
      config.findPattern = args[i + 1];
      i++;
    } else if (args[i] === '--types' && args[i + 1]) {
      config.fileTypes = args[i + 1].split(',').map(t => t.trim());
      i++;
    } else if (args[i] === '--folder' && args[i + 1]) {
      if (config.queryMode || config.findMode) {
        console.log('Warning: --folder ignored in query/find mode');
      } else {
        config.folderQueue = [args[i + 1]];
      }
      i++;
    } else if (args[i] === '--no-renditions') {
      config.downloadRenditions = false;
    } else if (args[i] === '--no-metadata') {
      config.downloadMetadata = false;
    }
  }

  // Validate query mode requirements
  if (config.queryMode && !config.queryFile) {
    console.error('ERROR: --query requires a file path');
    console.log('Example: node script.js --query assets.json');
    process.exit(1);
  }

  // Validate find mode requirements
  if ((config.findMode || config.findDownloadMode) && !config.findPattern && !config.findMultipleMode && !config.findStringMode) {
    console.error('ERROR: Find commands require a search pattern');
    console.log('Example: node script.js --find "icon2-returns.png"');
    console.log('Example: node script.js --find-download "icon2-returns.png"');
    console.log('Example: node script.js --find-string "burton.jpeg"');
    process.exit(1);
  }

  if (config.findMultipleMode && (!config.findPatterns || config.findPatterns.length === 0)) {
    console.error('ERROR: --find-multiple or --find-multiple-download requires patterns');
    console.log('Example: node script.js --find-multiple "icon2,perks,logo"');
    console.log('Example: node script.js --find-multiple-download "icon2,perks,logo"');
    process.exit(1);
  }

  if (config.findStringMode && !config.findPattern) {
    console.error('ERROR: --find-string or --find-string-download requires a string');
    console.log('Example: node script.js --find-string "burton.jpeg"');
    console.log('Example: node script.js --find-string "icon2,perks,logo"');
    process.exit(1);
  }

  // Ensure only one mode is active
  const activeModes = [
    config.queryMode,
    config.findMode && !config.findDownloadMode && !config.findMultipleMode && !config.findStringMode,
    config.testMode
  ].filter(Boolean).length;

  if (activeModes > 1) {
    console.error('ERROR: Cannot use multiple modes simultaneously');
    console.log('Choose one: --query, --find, --find-multiple, --find-string, --find-download, --find-multiple-download, --find-string-download, --test-10, or normal discovery mode');
    process.exit(1);
  }

  // Run main function
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
