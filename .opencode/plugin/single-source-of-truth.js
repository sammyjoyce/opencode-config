// .opencode/plugin/single-source-of-truth.js
// Blocks variant filenames ("enhanced", "simple", "refactored", "v2", etc.)
//
// Rationale: enforce single sources of truth—update existing files instead of
// creating alternates. Shows a visible error and hints corrective behavior.
//
// Tested with OpenCode plugin API ("tool.execute.before") and the write/patch tools.
// Ref: https://opencode.ai/docs/plugins/  and  https://opencode.ai/docs/modes/

import path from "node:path";

export const SingleSourceOfTruthGuard = async ({ client }) => {
  // Default banned tokens (case-insensitive). Tune to taste.
  const BANNED = new Set([
    "enhanced", "enhance",
    "simple", "simplified",
    "refactored", "refactor",
    "optimized", "optimize",
    "alternate", "alternative", "alt",
    "new", "final", "updated", "rewrite",
    "copy", "backup", "bak",
    "temp", "tmp",
    "legacy", "old",
  ]);

  // Helper: detect v2/v3/... tokens
  const isVersionToken = (t) => /^v\d+$/.test(t);

  // Normalize CamelCase to snake-ish for token matching
  const tokenize = (basename) => {
    const stem = basename.replace(/\.[^.]+$/, "");
    const snake = stem.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return snake.split(/[^a-z0-9]+/).filter(Boolean);
  };

  const shouldBlockPath = (filePath) => {
    const base = path.basename(filePath);
    const tokens = tokenize(base);
    return tokens.some((t) => BANNED.has(t) || isVersionToken(t));
  };

  const reject = async (filePath, via) => {
    const msg =
      `❌ Rejected ${via} for "${filePath}". ` +
      "This project enforces a single source of truth—update the existing file " +
      "instead of creating a variant (e.g., “enhanced”, “simple”, “v2”). " +
      "Please produce an in-place edit or a patch that updates the original.";
    // Best-effort toast in the TUI (non-fatal if unsupported)
    try {
      await client.tui.showToast({ message: msg, variant: "error" });
      // SDK exposes TUI APIs; safe to call from plugins. 
      // See: opencode SDK -> TUI APIs.
    } catch (_) {}
    throw new Error(msg);
  };

  // Parse new-file additions from a unified diff (patch tool)
  const parseNewFilesFromPatch = (patchText) => {
    const out = new Set();
    if (typeof patchText !== "string") return out;
    const lines = patchText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // new file indicated by 'new file mode' OR '--- /dev/null' + '+++ b/<path>'
      if (/^diff --git a\/.+ b\/(.+)$/.test(line)) {
        // Look ahead for explicit markers
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          if (/^new file mode /.test(lines[j])) {
            // Next '+++ b/<path>' will hold path
            for (let k = j; k < Math.min(j + 6, lines.length); k++) {
              const m = /^\+\+\+\s+b\/(.+)$/.exec(lines[k]);
              if (m) out.add(m[1]);
            }
            break;
          }
          if (/^---\s+\/dev\/null$/.test(lines[j])) {
            for (let k = j; k < Math.min(j + 6, lines.length); k++) {
              const m = /^\+\+\+\s+b\/(.+)$/.exec(lines[k]);
              if (m) out.add(m[1]);
            }
            break;
          }
        }
      }
    }
    return out;
  };

  return {
    // Runs before any tool is executed.
    // Ref example pattern (.env guard): opencode.ai/docs/plugins
    "tool.execute.before": async (input, output) => {
      const tool = input?.tool;

      // 1) Direct file creation
      if (tool === "write") {
        // write tool args typically: { filePath: string, content: string }
        // Confirmed in multiple issue threads (schema expects 'filePath', 'content' as strings).
        const p = output?.args?.filePath ?? output?.args?.path;
        if (typeof p === "string" && shouldBlockPath(p)) {
          await reject(p, "write");
        }
      }

      // 2) Patches that add files
      if (tool === "patch") {
        const patchText = output?.args?.patch ?? output?.args?.content;
        const newFiles = parseNewFilesFromPatch(patchText);
        for (const p of newFiles) {
          if (shouldBlockPath(p)) {
            await reject(p, "patch(add)");
          }
        }
      }

      // You *could* also guard 'edit' if it ever tries to create new files,
      // but OpenCode’s write/patch cover creation; edit is for modifying existing files.
    },
  };
};

