#!/usr/bin/env node
/**
 * VMware Fusion MCP Server
 *
 * Provides MCP tools to manage VMware Fusion virtual machines
 * via the `vmrun` command-line utility on macOS.
 *
 * Tools include: listing VMs, start/stop/suspend, snapshots,
 * guest IP addresses, and VM information.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Constants ───────────────────────────────────────────────────────────────

const CHARACTER_LIMIT = 25000;

/** Default paths where VMware Fusion installs vmrun */
const VMRUN_PATHS = [
  "/Applications/VMware Fusion.app/Contents/Library/vmrun",
  "/Applications/VMware Fusion Tech Preview.app/Contents/Library/vmrun",
];

/** Common directories where .vmx files are stored */
const VM_SEARCH_DIRS = [
  join(homedir(), "Virtual Machines.localized"),
  join(homedir(), "Virtual Machines"),
  join(homedir(), "Documents", "Virtual Machines.localized"),
  join(homedir(), "Documents", "Virtual Machines"),
];

// ─── Utilities ───────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

let cachedVmrunPath: string | null = null;

/**
 * Find the vmrun binary on the system.
 * Checks VMRUN_PATH env var first, then known locations.
 */
async function findVmrun(): Promise<string> {
  if (cachedVmrunPath) return cachedVmrunPath;

  // Check env var override
  if (process.env.VMRUN_PATH) {
    try {
      await stat(process.env.VMRUN_PATH);
      cachedVmrunPath = process.env.VMRUN_PATH;
      return cachedVmrunPath;
    } catch {
      // Fall through to default paths
    }
  }

  for (const p of VMRUN_PATHS) {
    try {
      await stat(p);
      cachedVmrunPath = p;
      return cachedVmrunPath;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not find vmrun. Ensure VMware Fusion is installed, or set the VMRUN_PATH environment variable."
  );
}

/**
 * Execute a vmrun command and return its stdout.
 * If vmPassword is provided, prepends `-vp <password>` for encrypted VMs.
 */
async function runVmrun(
  args: string[],
  timeoutMs = 30000,
  vmPassword?: string
): Promise<string> {
  const vmrun = await findVmrun();
  // Prepend encryption password if provided
  const fullArgs = vmPassword ? ["-vp", vmPassword, ...args] : args;
  try {
    const { stdout } = await execFileAsync(vmrun, fullArgs, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error: unknown) {
    if (error instanceof Error) {
      const execErr = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const errMsg = execErr.stderr?.trim() || execErr.stdout?.trim() || error.message;
      if (execErr.code === "ETIMEDOUT") {
        throw new Error("vmrun command timed out. The VM may be unresponsive.");
      }
      if (errMsg.includes("Encrypted virtual machine password")) {
        throw new Error(
          "This VM is encrypted. Please provide the vm_password parameter to unlock it."
        );
      }
      throw new Error(`vmrun error: ${errMsg}`);
    }
    throw error;
  }
}

/**
 * Recursively scan directories for .vmx files.
 */
async function findVmxFiles(dir: string, depth = 3): Promise<string[]> {
  if (depth <= 0) return [];
  const results: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".vmx")) {
        results.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const sub = await findVmxFiles(fullPath, depth - 1);
        results.push(...sub);
      }
    }
  } catch {
    // Directory not accessible — skip
  }

  return results;
}

/**
 * Parse key=value pairs from a .vmx file to extract VM metadata.
 */
async function parseVmxFile(
  vmxPath: string
): Promise<Record<string, string>> {
  try {
    const content = await readFile(vmxPath, "utf-8");
    const data: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(.+?)\s*=\s*"(.*)"$/);
      if (match) {
        data[match[1].trim()] = match[2];
      }
    }
    return data;
  } catch {
    return {};
  }
}

/**
 * Derive a human-friendly display name from a vmx path or its contents.
 */
function deriveVmName(vmxPath: string, vmxData?: Record<string, string>): string {
  if (vmxData?.displayName) return vmxData.displayName;
  const parentDir = basename(dirname(vmxPath));
  if (parentDir.endsWith(".vmwarevm")) {
    return parentDir.replace(".vmwarevm", "");
  }
  return basename(vmxPath, ".vmx");
}

interface VmInfo {
  name: string;
  vmxPath: string;
  guestOS?: string;
  memoryMB?: string;
  numCPUs?: string;
  annotation?: string;
  hardwareVersion?: string;
}

async function getVmInfo(vmxPath: string): Promise<VmInfo> {
  const data = await parseVmxFile(vmxPath);
  return {
    name: deriveVmName(vmxPath, data),
    vmxPath,
    guestOS: data["guestOS"] ?? data["guestos"],
    memoryMB: data["memsize"],
    numCPUs: data["numvcpus"],
    annotation: data["annotation"],
    hardwareVersion: data["virtualHW.version"],
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "vmware-fusion-mcp-server",
  version: "1.0.0",
});

// ─── Tool: fusion_list_running ───────────────────────────────────────────────

server.registerTool(
  "fusion_list_running",
  {
    title: "List Running VMs",
    description: `List all currently running VMware Fusion virtual machines.\n\nReturns the count and paths of all running VMs, along with their display names.\n\nReturns:\n  - total: number of running VMs\n  - vms: array of { name, vmxPath }\n\nNote: Only VMs started by the current user are shown (use sudo for root-started VMs).`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const output = await runVmrun(["list"]);
      const lines = output.split("\n");
      const totalMatch = lines[0]?.match(/Total running VMs:\s*(\d+)/);
      const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
      const vmxPaths = lines.slice(1).filter((l) => l.trim().length > 0);

      const vms: VmInfo[] = [];
      for (const vmxPath of vmxPaths) {
        vms.push(await getVmInfo(vmxPath));
      }

      const result = { total, vms };
      const text =
        total === 0
          ? "No VMs are currently running."
          : [
              `**${total} running VM(s):**`,
              "",
              ...vms.map(
                (vm) => `- **${vm.name}** — \`${vm.vmxPath}\` (${vm.guestOS ?? "unknown OS"}, ${vm.memoryMB ?? "?"}MB RAM)`
              ),
            ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error listing running VMs: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_list_all ───────────────────────────────────────────────────

server.registerTool(
  "fusion_list_all",
  {
    title: "Discover All VMs",
    description: `Discover all VMware Fusion virtual machines on the system by scanning common VM directories.\n\nScans ~/Virtual Machines.localized and related paths for .vmx files.\nAlso accepts an optional extra directory to search.\n\nArgs:\n  - extra_dir (string, optional): Additional directory path to scan for VMs.\n\nReturns:\n  - total: number of VMs found\n  - vms: array of { name, vmxPath, guestOS, memoryMB, numCPUs }`,
    inputSchema: {
      extra_dir: z.string().optional().describe("Optional additional directory to scan for .vmx files"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ extra_dir }) => {
    try {
      const dirsToSearch = [...VM_SEARCH_DIRS];
      if (extra_dir) dirsToSearch.push(extra_dir);

      const allVmx: string[] = [];
      for (const dir of dirsToSearch) {
        const found = await findVmxFiles(dir);
        allVmx.push(...found);
      }

      const unique = [...new Set(allVmx)];

      let runningPaths: Set<string>;
      try {
        const listOutput = await runVmrun(["list"]);
        const lines = listOutput.split("\n").slice(1).filter((l) => l.trim());
        runningPaths = new Set(lines);
      } catch {
        runningPaths = new Set();
      }

      const vms = await Promise.all(
        unique.map(async (vmxPath) => {
          const info = await getVmInfo(vmxPath);
          return { ...info, running: runningPaths.has(vmxPath) };
        })
      );

      const result = { total: vms.length, vms };
      const text =
        vms.length === 0
          ? "No virtual machines found on this system."
          : [
              `**${vms.length} VM(s) found:**`,
              "",
              ...vms.map(
                (vm) =>
                  `- **${vm.name}** ${vm.running ? "Running" : "Stopped"} — ${vm.guestOS ?? "unknown OS"}, ${vm.memoryMB ?? "?"}MB RAM, ${vm.numCPUs ?? "?"}  vCPUs\n  \`${vm.vmxPath}\``
              ),
            ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error discovering VMs: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_get_vm_info ────────────────────────────────────────────────

const VmxPathSchema = z.object({
  vmx_path: z
    .string()
    .min(1)
    .describe("Absolute path to the .vmx file of the virtual machine"),
  vm_password: z
    .string()
    .optional()
    .describe("Encryption password for the VM (required if the VM is encrypted)"),
}).strict();

type VmxPathInput = z.infer<typeof VmxPathSchema>;

server.registerTool(
  "fusion_get_vm_info",
  {
    title: "Get VM Details",
    description: `Get detailed information about a specific VMware Fusion virtual machine.\n\nReads the .vmx configuration file and checks running status.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n\nReturns:\n  Object with name, vmxPath, guestOS, memoryMB, numCPUs, annotation, hardwareVersion, running status.`,
    inputSchema: VmxPathSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, vm_password }: VmxPathInput) => {
    try {
      const info = await getVmInfo(vmx_path);

      let running = false;
      try {
        const listOutput = await runVmrun(["list"]);
        running = listOutput.includes(vmx_path);
      } catch {
        // Can't determine running state
      }

      let ipAddress: string | undefined;
      if (running) {
        try {
          ipAddress = await runVmrun(["getGuestIPAddress", vmx_path], 30000, vm_password);
        } catch {
          // IP not available
        }
      }

      const result = { ...info, running, ipAddress };

      const text = [
        `## ${info.name}`,
        "",
        `| Property | Value |`,
        `|----------|-------|`,
        `| Status | ${running ? "Running" : "Stopped"} |`,
        `| Guest OS | ${info.guestOS ?? "Unknown"} |`,
        `| Memory | ${info.memoryMB ?? "Unknown"} MB |`,
        `| vCPUs | ${info.numCPUs ?? "Unknown"} |`,
        `| HW Version | ${info.hardwareVersion ?? "Unknown"} |`,
        ...(ipAddress ? [`| IP Address | ${ipAddress} |`] : []),
        `| VMX Path | \`${info.vmxPath}\` |`,
        ...(info.annotation ? [``, `**Notes:** ${info.annotation}`] : []),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error getting VM info: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_start_vm ───────────────────────────────────────────────────

server.registerTool(
  "fusion_start_vm",
  {
    title: "Start VM",
    description: `Start (power on) a VMware Fusion virtual machine.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - nogui (boolean, optional): If true, starts the VM without a GUI window (headless). Default: false.\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      nogui: z.boolean().default(false).describe("Start headless without a GUI window"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, nogui, vm_password }) => {
    try {
      const args = ["start", vmx_path];
      if (nogui) args.push("nogui");
      await runVmrun(args, 60000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `VM **${info.name}** started successfully${nogui ? " (headless)" : ""}.` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error starting VM: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_stop_vm ────────────────────────────────────────────────────

server.registerTool(
  "fusion_stop_vm",
  {
    title: "Stop VM",
    description: `Stop (power off) a VMware Fusion virtual machine.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - mode (string, optional): "soft" sends a shutdown signal to the guest OS (graceful). "hard" forces immediate power off. Default: "soft".\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      mode: z.enum(["soft", "hard"]).default("soft").describe("'soft' for graceful shutdown, 'hard' for forced power off"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, mode, vm_password }) => {
    try {
      await runVmrun(["stop", vmx_path, mode], 120000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `VM **${info.name}** stopped (${mode}).` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error stopping VM: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_suspend_vm ─────────────────────────────────────────────────

server.registerTool(
  "fusion_suspend_vm",
  {
    title: "Suspend VM",
    description: `Suspend a running VMware Fusion virtual machine. Saves the VM's state to disk.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: VmxPathSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, vm_password }: VmxPathInput) => {
    try {
      await runVmrun(["suspend", vmx_path], 120000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `VM **${info.name}** suspended.` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error suspending VM: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_reset_vm ───────────────────────────────────────────────────

server.registerTool(
  "fusion_reset_vm",
  {
    title: "Reset VM",
    description: `Reset (reboot) a VMware Fusion virtual machine.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - mode (string, optional): "soft" for graceful reboot, "hard" for forced reset. Default: "soft".\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      mode: z.enum(["soft", "hard"]).default("soft").describe("'soft' for graceful reboot, 'hard' for forced reset"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, mode, vm_password }) => {
    try {
      await runVmrun(["reset", vmx_path, mode], 60000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `VM **${info.name}** reset (${mode}).` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error resetting VM: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_get_ip ─────────────────────────────────────────────────────

server.registerTool(
  "fusion_get_ip",
  {
    title: "Get VM IP Address",
    description: `Get the IP address of a running VMware Fusion guest OS.\n\nThe VM must be running and have VMware Tools installed for this to work.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - wait (boolean, optional): If true, waits for the guest to obtain an IP. Default: true.\n\nReturns:\n  The IP address as a string, or an error if unavailable.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      wait: z.boolean().default(true).describe("Wait for the guest to obtain an IP address"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, wait, vm_password }) => {
    try {
      const args = ["getGuestIPAddress", vmx_path];
      if (wait) args.push("-wait");
      const ip = await runVmrun(args, 60000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `**${info.name}** IP address: \`${ip}\`` }],
        structuredContent: { name: info.name, vmxPath: vmx_path, ipAddress: ip },
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Error getting IP: ${formatError(error)}. Ensure the VM is running and VMware Tools is installed.`,
        }],
      };
    }
  }
);

// ─── Tool: fusion_list_snapshots ─────────────────────────────────────────────

server.registerTool(
  "fusion_list_snapshots",
  {
    title: "List VM Snapshots",
    description: `List all snapshots of a VMware Fusion virtual machine.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n\nReturns:\n  - total: number of snapshots\n  - snapshots: array of snapshot names`,
    inputSchema: VmxPathSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, vm_password }: VmxPathInput) => {
    try {
      const output = await runVmrun(["listSnapshots", vmx_path], 30000, vm_password);
      const lines = output.split("\n");
      const totalMatch = lines[0]?.match(/Total snapshots:\s*(\d+)/);
      const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
      const snapshots = lines.slice(1).filter((l) => l.trim().length > 0);

      const info = await getVmInfo(vmx_path);
      const result = { name: info.name, vmxPath: vmx_path, total, snapshots };

      const text =
        total === 0
          ? `No snapshots for **${info.name}**.`
          : [
              `**${total} snapshot(s) for ${info.name}:**`,
              "",
              ...snapshots.map((s, i) => `${i + 1}. ${s}`),
            ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error listing snapshots: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_create_snapshot ────────────────────────────────────────────

server.registerTool(
  "fusion_create_snapshot",
  {
    title: "Create Snapshot",
    description: `Create a new snapshot of a VMware Fusion virtual machine.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - snapshot_name (string): Name for the new snapshot.\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      snapshot_name: z.string().min(1).max(200).describe("Name for the new snapshot"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, snapshot_name, vm_password }) => {
    try {
      await runVmrun(["snapshot", vmx_path, snapshot_name], 120000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `Snapshot **"${snapshot_name}"** created for VM **${info.name}**.` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error creating snapshot: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_revert_snapshot ────────────────────────────────────────────

server.registerTool(
  "fusion_revert_snapshot",
  {
    title: "Revert to Snapshot",
    description: `Revert a VMware Fusion virtual machine to a previous snapshot.\n\nWARNING: This discards any changes made since the snapshot was taken.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - snapshot_name (string): Name of the snapshot to revert to.\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      snapshot_name: z.string().min(1).describe("Name of the snapshot to revert to"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, snapshot_name, vm_password }) => {
    try {
      await runVmrun(["revertToSnapshot", vmx_path, snapshot_name], 120000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `VM **${info.name}** reverted to snapshot **"${snapshot_name}"**.` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error reverting snapshot: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_delete_snapshot ────────────────────────────────────────────

server.registerTool(
  "fusion_delete_snapshot",
  {
    title: "Delete Snapshot",
    description: `Delete a snapshot from a VMware Fusion virtual machine.\n\nWARNING: This permanently removes the snapshot and its state. This cannot be undone.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - snapshot_name (string): Name of the snapshot to delete.\n\nReturns:\n  Confirmation message on success.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      snapshot_name: z.string().min(1).describe("Name of the snapshot to delete"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, snapshot_name, vm_password }) => {
    try {
      await runVmrun(["deleteSnapshot", vmx_path, snapshot_name], 120000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `Snapshot **"${snapshot_name}"** deleted from VM **${info.name}**.` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error deleting snapshot: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_check_tools ────────────────────────────────────────────────

server.registerTool(
  "fusion_check_tools",
  {
    title: "Check VMware Tools Status",
    description: `Check the status of VMware Tools in a virtual machine's guest OS.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n\nReturns:\n  The VMware Tools status (e.g., "installed", "running", "not installed").`,
    inputSchema: VmxPathSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, vm_password }: VmxPathInput) => {
    try {
      const status = await runVmrun(["checkToolsState", vmx_path], 30000, vm_password);
      const info = await getVmInfo(vmx_path);
      return {
        content: [{ type: "text", text: `**${info.name}** VMware Tools status: **${status}**` }],
        structuredContent: { name: info.name, vmxPath: vmx_path, toolsStatus: status },
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error checking VMware Tools: ${formatError(error)}` }],
      };
    }
  }
);

// ─── Tool: fusion_run_in_guest ───────────────────────────────────────────────

server.registerTool(
  "fusion_run_in_guest",
  {
    title: "Run Program in Guest",
    description: `Run a program inside a VMware Fusion guest OS.\n\nRequires VMware Tools to be installed and running in the guest.\n\nArgs:\n  - vmx_path (string): Absolute path to the VM's .vmx file.\n  - guest_user (string): Username for guest authentication.\n  - guest_password (string): Password for guest authentication.\n  - program (string): Full path to the program inside the guest OS.\n  - program_args (string, optional): Arguments to pass to the program.\n  - no_wait (boolean, optional): If true, returns immediately without waiting for the program to finish. Default: false.\n\nReturns:\n  Output from the program or confirmation that it was launched.`,
    inputSchema: {
      vmx_path: z.string().min(1).describe("Absolute path to the .vmx file"),
      guest_user: z.string().min(1).describe("Guest OS username"),
      guest_password: z.string().min(1).describe("Guest OS password"),
      program: z.string().min(1).describe("Full path to the program inside the guest"),
      program_args: z.string().default("").describe("Arguments to pass to the program"),
      no_wait: z.boolean().default(false).describe("Return immediately without waiting for completion"),
      vm_password: z.string().optional().describe("Encryption password for the VM (if encrypted)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ vmx_path, guest_user, guest_password, program, program_args, no_wait, vm_password }) => {
    try {
      const args = [
        "-gu", guest_user,
        "-gp", guest_password,
        "runProgramInGuest",
        vmx_path,
        ...(no_wait ? ["-noWait"] : []),
        program,
        ...(program_args ? [program_args] : []),
      ];

      const output = await runVmrun(args, 120000, vm_password);
      const info = await getVmInfo(vmx_path);

      return {
        content: [{
          type: "text",
          text: no_wait
            ? `Program launched in guest **${info.name}**: \`${program}\``
            : `Program completed in guest **${info.name}**:\n\`\`\`\n${output || "(no output)"}\n\`\`\``,
        }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Error running program in guest: ${formatError(error)}. Ensure VMware Tools is installed and credentials are correct.`,
        }],
      };
    }
  }
);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate vmrun is available at startup
  try {
    await findVmrun();
    console.error("vmrun found at:", cachedVmrunPath);
  } catch (error) {
    console.error("WARNING:", formatError(error));
    console.error("Server will start but tools may fail until VMware Fusion is installed.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VMware Fusion MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
