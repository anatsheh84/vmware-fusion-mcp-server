# VMware Fusion MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets AI assistants manage **VMware Fusion** virtual machines on macOS through the `vmrun` command-line tool.

## What It Does

This server exposes VMware Fusion's `vmrun` CLI as a set of MCP tools, allowing Claude (or any MCP-compatible client) to:

- **Discover & inspect** VMs on your system
- **Power manage** VMs (start, stop, suspend, reset)
- **Manage snapshots** (create, revert, delete)
- **Query guest info** (IP address, VMware Tools status)
- **Run programs** inside guest operating systems

All tools support **encrypted VMs** via an optional `vm_password` parameter.

## Prerequisites

- **macOS** with [VMware Fusion](https://www.vmware.com/products/fusion.html) installed
- **Node.js** >= 18
- The `vmrun` binary (bundled with VMware Fusion)

## Quick Start

```bash
# Clone the repo
git clone https://github.com/anatsheh84/vmware-fusion-mcp-server.git
cd vmware-fusion-mcp-server

# Install dependencies and build
npm install
npm run build
```

## Configuration

### Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vmware-fusion": {
      "command": "node",
      "args": ["/path/to/vmware-fusion-mcp-server/dist/index.js"]
    }
  }
}
```

### Claude Code

Add to your `.claude.json` or run:

```bash
claude mcp add vmware-fusion node /path/to/vmware-fusion-mcp-server/dist/index.js
```

### Custom vmrun Path

If VMware Fusion is installed in a non-standard location, set `VMRUN_PATH`:

```json
{
  "env": {
    "VMRUN_PATH": "/custom/path/to/vmrun"
  }
}
```

## Available Tools

### Discovery & Info

| Tool | Description |
|------|-------------|
| `fusion_list_running` | List all currently running VMs |
| `fusion_list_all` | Discover all VMs on the system by scanning common directories |
| `fusion_get_vm_info` | Get detailed info about a VM (OS, RAM, CPUs, IP, status) |

### Power Management

| Tool | Description |
|------|-------------|
| `fusion_start_vm` | Power on a VM (with optional headless/nogui mode) |
| `fusion_stop_vm` | Shut down a VM (soft/graceful or hard/forced) |
| `fusion_suspend_vm` | Suspend a running VM and save state to disk |
| `fusion_reset_vm` | Reboot a VM (soft or hard) |

### Networking

| Tool | Description |
|------|-------------|
| `fusion_get_ip` | Get the guest OS IP address (requires VMware Tools) |

### Snapshots

| Tool | Description |
|------|-------------|
| `fusion_list_snapshots` | List all snapshots for a VM |
| `fusion_create_snapshot` | Create a new named snapshot |
| `fusion_revert_snapshot` | Revert to a previous snapshot |
| `fusion_delete_snapshot` | Permanently delete a snapshot |

### Guest Operations

| Tool | Description |
|------|-------------|
| `fusion_check_tools` | Check if VMware Tools is installed/running |
| `fusion_run_in_guest` | Run a program inside the guest OS |

## Encrypted VM Support

All tools that operate on a specific VM accept an optional `vm_password` parameter. If your VM is encrypted in VMware Fusion, pass the encryption password and the server will use `vmrun -vp` to unlock it.

## Example Prompts

Once configured, you can ask your AI assistant:

- *"List all my virtual machines"*
- *"Start my Ubuntu VM in headless mode"*
- *"What's the IP address of my Windows VM?"*
- *"Create a snapshot called 'before-update' for my dev VM"*
- *"Suspend all running VMs"*
- *"Revert my test VM to the 'clean-state' snapshot"*

## How It Works

The server wraps VMware Fusion's `vmrun` CLI and exposes it via the MCP protocol over stdio. It:

1. **Auto-discovers** the `vmrun` binary from standard Fusion install paths
2. **Scans** `~/Virtual Machines.localized` and related directories for `.vmx` files
3. **Parses** `.vmx` configuration files to extract VM metadata (name, OS, RAM, CPUs)
4. **Executes** `vmrun` commands with proper error handling and timeout management

## Tech Stack

- **TypeScript** with strict mode
- **@modelcontextprotocol/sdk** for MCP server implementation
- **Zod** for input validation
- **stdio** transport for local integration

## Development

```bash
# Watch mode for development
npm run dev

# Build for production
npm run build

# Run directly
npm start
```

## License

MIT
