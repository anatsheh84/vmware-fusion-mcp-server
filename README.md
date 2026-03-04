# VMware Fusion MCP Server

An MCP (Model Context Protocol) server that lets AI assistants manage VMware Fusion virtual machines on macOS via the `vmrun` command-line tool.

## Prerequisites

- **macOS** with **VMware Fusion** (or Fusion Pro) installed
- **Node.js** >= 18
- The `vmrun` binary (bundled with VMware Fusion at `/Applications/VMware Fusion.app/Contents/Library/vmrun`)

## Installation

```bash
cd vmware-fusion-mcp-server
npm install
npm run build
```

## Configuration

### Claude Desktop / Claude Code

Add this to your MCP settings (e.g. `claude_desktop_config.json` or `.claude.json`):

```json
{
  "mcpServers": {
    "vmware-fusion": {
      "command": "node",
      "args": ["/path/to/vmware-fusion-mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

### Custom vmrun path

If VMware Fusion is installed in a non-standard location, set the `VMRUN_PATH` environment variable:

```json
{
  "env": {
    "VMRUN_PATH": "/custom/path/to/vmrun"
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `fusion_list_running` | List all currently running VMs |
| `fusion_list_all` | Discover all VMs on the system (scans common directories) |
| `fusion_get_vm_info` | Get detailed info about a specific VM (OS, RAM, CPUs, IP) |
| `fusion_start_vm` | Start (power on) a VM, optionally headless |
| `fusion_stop_vm` | Stop a VM (soft/graceful or hard/forced) |
| `fusion_suspend_vm` | Suspend a running VM to disk |
| `fusion_reset_vm` | Reboot a VM (soft or hard) |
| `fusion_get_ip` | Get the guest OS IP address |
| `fusion_list_snapshots` | List all snapshots of a VM |
| `fusion_create_snapshot` | Create a new snapshot |
| `fusion_revert_snapshot` | Revert to a previous snapshot |
| `fusion_delete_snapshot` | Delete a snapshot |
| `fusion_check_tools` | Check VMware Tools status in the guest |
| `fusion_run_in_guest` | Run a program inside the guest OS |

## Example Usage

Once connected, you can ask your AI assistant things like:

- "List all my virtual machines"
- "Start my Ubuntu VM"
- "What's the IP address of my Windows VM?"
- "Create a snapshot called 'before-update' for my dev VM"
- "Stop all running VMs gracefully"

## How It Works

The server wraps VMware Fusion's `vmrun` CLI utility and exposes its functionality as MCP tools. It automatically discovers VMs by scanning standard macOS VM directories (`~/Virtual Machines.localized`, etc.) and reads `.vmx` configuration files to extract VM metadata like display names, guest OS type, memory, and CPU count.

## License

MIT
