# Universal Dynamic Asset Downloader

A powerful Node.js tool for bulk downloading assets from Adobe Experience Manager (AEM) Digital Asset Management (DAM). Features intelligent discovery, search capabilities, and comprehensive metadata extraction.

## Features

- **Smart DAM Discovery** - Automatically crawls and discovers all assets in your AEM DAM
- **Multiple Search Modes** - Find assets by filename, pattern, or multiple patterns
- **Query-Based Downloads** - Download specific assets from a JSON file
- **Comprehensive Metadata** - Extracts and saves full asset metadata
- **Rendition Support** - Optionally download asset renditions
- **Concurrent Downloads** - Configurable parallel downloads with rate limiting
- **Retry Logic** - Automatic retry with exponential backoff
- **Progress Tracking** - Real-time progress updates and detailed reports
- **File Filtering** - Filter by file type, size, and patterns

## Prerequisites

- Node.js 14.0.0 or higher
- Access to an AEM instance with valid authentication credentials

## Installation

1. Clone or download this repository:

```bash
git clone <repository-url>
cd aem-asset-downloader
```

2. Copy the environment template and configure:

```bash
cp .env.example .env
```

3. Edit `.env` with your AEM credentials:

```bash
# Required settings
BASE_URL=https://your-aem-instance.com
COOKIE=your-aem-session-cookie
OUTPUT_DIR=./dam-downloads
```

## Getting Your AEM Cookie

1. Log into your AEM instance in a web browser
2. Open Developer Tools (F12 or right-click → Inspect)
3. Go to the **Network** tab
4. Navigate to any page in AEM or refresh
5. Click on any request to AEM
6. In the **Headers** section, find the **Cookie** header under Request Headers
7. Copy the entire cookie value

## Usage

### Basic Commands

```bash
# Show help
node aem.js --help

# Test connection
node aem.js --test

# Test download (10 assets only)
node aem.js --test-10

# Full DAM discovery and download
node aem.js
```

### Search & Find

```bash
# Search for assets (without downloading)
node aem.js --find "icon-logo.png"

# Search and download immediately
node aem.js --find-download "icon-logo.png"

# Search multiple patterns
node aem.js --find-multiple "icon,logo,banner"

# Search multiple patterns and download
node aem.js --find-multiple-download "icon,logo,banner"

# Search from string (single filename or comma-separated)
node aem.js --find-string "product-image.jpg"
node aem.js --find-string-download "image1,image2,image3"
```

### Query-Based Downloads

```bash
# Download specific assets from a JSON file
node aem.js --query assets.json
```

### Filtering Options

```bash
# Download only specific file types
node aem.js --types jpg,png,pdf

# Start from a specific folder
node aem.js --folder /content/dam/my-project

# Skip metadata files
node aem.js --no-metadata

# Skip renditions
node aem.js --no-renditions

# Limit test downloads
node aem.js --test-limit 50
```

## Query File Formats

The `--query` option supports multiple JSON formats:

### Simple Array (Full Paths)

```json
["/content/dam/project/image1.jpg", "/content/dam/project/image2.png"]
```

### Simple Array (Relative Paths)

```json
["/1683123905658/icon-returns.png", "/1679944936835/logo.png"]
```

_Relative paths are automatically prefixed with `/content/dam`_

### Object with Assets Array

```json
{
  "assets": [
    "/content/dam/path/to/asset1.jpg",
    "/content/dam/path/to/asset2.png"
  ]
}
```

### Object with Custom Base Path

```json
{
  "basePath": "/content/dam/my-project",
  "assets": ["/icons/icon1.png", "/images/logo.jpg"]
}
```

### Plain Text (One Path Per Line)

```
/content/dam/path/to/asset1.jpg
/content/dam/path/to/asset2.png
# Comments are ignored
```

## Environment Variables

| Variable              | Required | Default           | Description                 |
| --------------------- | -------- | ----------------- | --------------------------- |
| `BASE_URL`            | Yes      | -                 | Your AEM instance URL       |
| `COOKIE`              | Yes      | -                 | AEM session cookie          |
| `OUTPUT_DIR`          | No       | `./dam-downloads` | Output directory            |
| `FILE_TYPES`          | No       | (all)             | Comma-separated file types  |
| `MIN_FILE_SIZE`       | No       | `0`               | Minimum file size (bytes)   |
| `MAX_FILE_SIZE`       | No       | `5000000000`      | Maximum file size (bytes)   |
| `MAX_CONCURRENT`      | No       | `3`               | Concurrent downloads        |
| `SLEEP_TIME`          | No       | `200`             | Delay between requests (ms) |
| `MAX_DEPTH`           | No       | `50`              | Max folder depth            |
| `REQUEST_TIMEOUT`     | No       | `30000`           | Request timeout (ms)        |
| `RETRY_ATTEMPTS`      | No       | `3`               | Retry attempts              |
| `RETRY_DELAY`         | No       | `1000`            | Delay between retries (ms)  |
| `DOWNLOAD_METADATA`   | No       | `true`            | Save metadata JSON          |
| `DOWNLOAD_RENDITIONS` | No       | `false`           | Download renditions         |

## Output Structure

```
dam-downloads/
├── project-name/
│   ├── images/
│   │   ├── photo.jpg
│   │   ├── photo.jpg.metadata.json
│   │   └── photo.jpg.renditions/
│   │       ├── cq5dam.web.1280.1280.jpeg
│   │       └── cq5dam.thumbnail.140.100.png
│   └── documents/
│       ├── report.pdf
│       └── report.pdf.metadata.json
├── download-report.json
└── config.json
```

## Metadata Files

Each downloaded asset has an accompanying `.metadata.json` file containing:

```json
{
  "asset": {
    "path": "/content/dam/project/image.jpg",
    "name": "image.jpg",
    "extension": "jpg",
    "mimeType": "image/jpeg",
    "size": 245678
  },
  "properties": {
    "width": 1920,
    "height": 1080,
    "created": "2024-01-15T10:30:00.000Z",
    "modified": "2024-06-20T14:45:00.000Z",
    "title": "Product Image",
    "description": "Main product photo",
    "keywords": ["product", "hero"],
    "creator": "Photoshop",
    "copyright": "© 2024 Company"
  },
  "aem": {
    "renditions": ["cq5dam.web.1280.1280.jpeg"],
    "originalMetadata": { ... }
  },
  "download": {
    "downloadedAt": "2024-11-27T12:00:00.000Z",
    "downloadedSize": 245678,
    "downloadUrl": "https://..."
  }
}
```

## Reports

After each run, a report is generated:

- `download-report.json` - Full download statistics
- `test-report.json` - Test mode report
- `query-report.json` - Query mode report
- `search-results-{timestamp}.json` - Search results
- `search-paths-{timestamp}.json` - Asset paths for query use

## Examples

### Workflow: Find and Download

```bash
# Step 1: Search for assets
node aem.js --find "product-banner"

# Step 2: Review search-results-*.json
# Step 3: Download using the generated paths file
node aem.js --query search-paths-1701091200000.json

# Or do it in one step:
node aem.js --find-download "product-banner"
```

### Download Specific Project Assets

```bash
# Download from a specific folder
node aem.js --folder /content/dam/marketing/2024-campaign

# Download only images
node aem.js --folder /content/dam/marketing --types jpg,png,webp
```

### Bulk Download with Query File

Create `my-assets.json`:

```json
{
  "basePath": "/content/dam/products",
  "assets": [
    "/electronics/laptop.png",
    "/electronics/phone.jpg",
    "/furniture/desk.png"
  ]
}
```

Then run:

```bash
node aem.js --query my-assets.json
```

## Troubleshooting

### Connection Failed

- Verify your `BASE_URL` is correct
- Check if your cookie is expired (re-login and get a new cookie)
- Ensure you have network access to the AEM instance

### No Assets Found

- Verify you have read permissions in the DAM
- Check if the path exists in AEM
- Try with `--folder` to specify a known path

### Downloads Failing

- Increase `REQUEST_TIMEOUT` for large files
- Reduce `MAX_CONCURRENT` if getting rate limited
- Check disk space in output directory

### Cookie Issues

- Cookies expire - get a fresh one if downloads fail
- Make sure to copy the entire cookie value
- Some cookies may contain special characters - wrap in quotes

## License

MIT License - see [LICENSE](LICENSE) for details.

## Disclaimer

This is an unofficial tool not affiliated with Adobe. See [DISCLAIMER.md](DISCLAIMER.md) for important legal information.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
# Universal-Dynamic-Asset-Downloader
