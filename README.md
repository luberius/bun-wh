# Release Webhook Deployer

A lightweight webhook server built with Bun that automatically deploys GitHub releases. It supports multiple projects, handles rollbacks, and maintains release history.

## Features

- 🚀 Fast deployment from GitHub releases (others soon!)
- 📦 Multiple project support
- 🔄 Automatic rollback on failure
- 🗄️ Release history management
- 🔒 Secure webhook validation
- 📝 Comprehensive logging

## Directory Structure

```
/home/your-user/webhook/
├── releases/
│   ├── project1/
│   │   ├── v1.0.0-2024-02-20T12-34-56/
│   │   └── v1.0.1-2024-02-21T15-30-00/
│   └── project2/
│       └── v2.0.0-2024-02-19T10-20-30/
└── current/
    ├── project1 -> ../releases/project1/v1.0.1-2024-02-21T15-30-00
    └── project2 -> ../releases/project2/v2.0.0-2024-02-19T10-20-30

## Prerequisites

- [Bun](https://bun.sh) installed
- GitHub repository with releases
- `unzip` command available on the system

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd github-webhook-deployer
```

2. Install dependencies:
```bash
bun install
```

3. Create and configure `config.json`:
```bash
cp config.example.json config.json
```

## Configuration

Example configuration:

```json
{
  "webhookSecret": "your-webhook-secret",
  "githubToken": "your-github-token",
  "baseDir": "/home/your-user/webhook",
  "projects": {
    "project1": {
    "name": "Project One",
    "githubRepo": "owner/repo",
    "webRoot": "/var/www/project1",  // Where to deploy your app 
    "keepReleases": 5,
    "asset": "release.zip",
    "postExtract": [
        "php artisan migrate"
    ],
    "preRollback": [
        "php artisan down"
    ],
    "branch": "main"
    }
  }
}
```

### Configuration Options

- `webhookSecret`: GitHub webhook secret for validation
- `githubToken`: (Optional) GitHub token for private repositories
- `baseDir`: Base directory for all deployments
- `projects`: Object containing project configurations
  - `name`: Project name
  - `githubRepo`: GitHub repository in format "owner/repo"
  - `webRoot`: Path to app directory
  - `keepReleases`: Number of releases to keep
  - `postExtract`: Commands to run after extraction
  - `preRollback`: Commands to run before rollback
  - `branch`: (Optional) Only deploy releases from this branch

## Usage

1. Start the server:
```bash
# Development mode with auto-reload
bun run dev

# Production mode
bun run start
```

2. Set up GitHub webhook:
   - Go to your repository settings
   - Add webhook: `https://your-domain/webhook/github/release`
   - Content type: `application/json`
   - Secret: Same as `webhookSecret` in config
   - Events: Select "Releases"

3. Test the webhook:
   - Create and publish a release in your GitHub repository
   - Check the logs for deployment status

## Local Testing

For local testing, you can use ngrok:

```bash
# Install ngrok
brew install ngrok  # macOS
# or download from https://ngrok.com/download

# Start your webhook server
bun run dev

# In another terminal, start ngrok
ngrok http 3000

# Use the ngrok URL in GitHub webhook settings
```

## Logs

Logs are stored in the `logs` directory:
- `server.log`: Main application logs
- Log levels: DEBUG, INFO, WARN, ERROR, FATAL
- Can be configured via `LOG_LEVEL` environment variable

## Environment Variables

- `PORT`: Server port (default: 3000)
- `LOG_LEVEL`: Logging level (default: info)
- `NODE_ENV`: Environment mode (development/production)

## Security

- Validates GitHub webhook signatures
- Supports branch-specific deployments
- Maintains secure file permissions
- Handles rollbacks safely

## Development

- Written in TypeScript
- Uses Bun for fast execution
- Structured logging with Pino
- Clean code architecture

## License

MIT License
