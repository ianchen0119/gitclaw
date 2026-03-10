import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf-8"));
const eventName = process.env.GITHUB_EVENT_NAME!;
const repo = process.env.GITHUB_REPOSITORY!;
const issueNumber: number = event.issue.number;

async function run(cmd: string[], opts?: { stdin?: any }): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "inherit",
    stdin: opts?.stdin,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim() };
}

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await run(["gh", ...args]);
  return stdout;
}

// Load reaction state from preinstall
const reactionState = existsSync("/tmp/reaction-state.json")
  ? JSON.parse(readFileSync("/tmp/reaction-state.json", "utf-8"))
  : null;

try {
  // --- Fetch issue ---
  const title = await gh("issue", "view", String(issueNumber), "--json", "title", "--jq", ".title");
  const body = await gh("issue", "view", String(issueNumber), "--json", "body", "--jq", ".body");

  // --- Resolve session ---
  mkdirSync("state/issues", { recursive: true });
  mkdirSync("state/sessions", { recursive: true });

  let mode = "new";
  let sessionPath = "";
  let savedModel = "";
  const mappingFile = `state/issues/${issueNumber}.json`;

  if (existsSync(mappingFile)) {
    const mapping = JSON.parse(readFileSync(mappingFile, "utf-8"));
    if (existsSync(mapping.sessionPath)) {
      mode = "resume";
      sessionPath = mapping.sessionPath;
      savedModel = mapping.model ?? "";
      console.log(`Found existing session: ${sessionPath}`);
    } else {
      console.log("Mapped session file missing, starting fresh");
    }
  } else {
    console.log("No session mapping found, starting fresh");
  }

  // --- Configure git ---
  await run(["git", "config", "user.name", "gitclaw[bot]"]);
  await run(["git", "config", "user.email", "gitclaw[bot]@users.noreply.github.com"]);

  // --- Setup GitHub Copilot auth ---
  const ghToken = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (ghToken) {
    const authDir = `${process.env.HOME}/.pi/agent`;
    mkdirSync(authDir, { recursive: true });
    writeFileSync(`${authDir}/auth.json`, JSON.stringify({
      "github-copilot": { type: "oauth", refresh: ghToken, access: "", expires: 0 },
    }, null, 2));
  }

  // --- Build prompt ---
  // Parse structured fields from GitHub issue form (### Section\n\ncontent)
  const MODEL_WHITELIST = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
  let model = savedModel || "gpt-4o";
  let prompt: string;

  if (eventName === "issue_comment") {
    prompt = event.comment.body;
  } else {
    // Try to extract ### Model and ### Task sections from issue form body
    const modelSection = body.match(/^###\s*Model\s*\n+([\s\S]*?)(?=\n###|\s*$)/m);
    const taskSection = body.match(/^###\s*Task\s*\n+([\s\S]*?)(?=\n###|\s*$)/m);
    if (modelSection) {
      const raw = modelSection[1].trim();
      if (!raw.startsWith("(") && MODEL_WHITELIST.test(raw)) {
        model = raw;
      }
    }
    const taskBody = taskSection ? taskSection[1].trim() : body;
    prompt = `${title}\n\n${taskBody}`;
  }

  // --- Run agent ---
  const piArgs = ["bunx", "pi", "--provider", "github-copilot", "--model", model, "--mode", "json", "--session-dir", "./state/sessions", "-p", prompt];
  if (mode === "resume" && sessionPath) {
    piArgs.push("--session", sessionPath);
  }

  const pi = Bun.spawn(piArgs, { stdout: "pipe", stderr: "inherit" });
  const tee = Bun.spawn(["tee", "/tmp/agent-raw.jsonl"], { stdin: pi.stdout, stdout: "inherit" });
  await tee.exited;

  // Extract text from the agent's final message
  const tac = Bun.spawn(["tac", "/tmp/agent-raw.jsonl"], { stdout: "pipe" });
  const jq = Bun.spawn(
    ["jq", "-r", "-s", '[ .[] | select(.type == "message_end") ] | if length > 0 then .[0].message.content[] | select(.type == "text") | .text else "" end'],
    { stdin: tac.stdout, stdout: "pipe" }
  );
  const agentText = (await new Response(jq.stdout).text()).trim();
  await jq.exited;

  // Find latest session file
  const { stdout: latestSession } = await run([
    "bash", "-c", "ls -t state/sessions/*.jsonl 2>/dev/null | head -1",
  ]);

  // --- Save session mapping ---
  if (latestSession) {
    writeFileSync(
      mappingFile,
      JSON.stringify({
        issueNumber,
        sessionPath: latestSession,
        model,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n"
    );
    console.log(`Saved mapping: issue #${issueNumber} -> ${latestSession}`);
  } else {
    console.log("Warning: no session file found to map");
  }

  // --- Commit and push ---
  await run(["git", "add", "-A"]);
  const { exitCode } = await run(["git", "diff", "--cached", "--quiet"]);
  if (exitCode !== 0) {
    await run(["git", "commit", "-m", `gitclaw: work on issue #${issueNumber}`]);
  }

  for (let i = 1; i <= 3; i++) {
    const push = await run(["git", "push", "origin", "main"]);
    if (push.exitCode === 0) break;
    console.log(`Push failed, rebasing and retrying (${i}/3)...`);
    await run(["git", "pull", "--rebase", "origin", "main"]);
  }

  // --- Comment on issue ---
  const commentBody = agentText.slice(0, 60000);
  if (commentBody) {
    await gh("issue", "comment", String(issueNumber), "--body", commentBody);
  } else {
    console.error("Warning: agent produced no text output, skipping comment");
  }

} finally {
  // --- Remove eyes reaction ---
  if (reactionState?.reactionId) {
    try {
      const { reactionId, reactionTarget, commentId } = reactionState;
      if (reactionTarget === "comment" && commentId) {
        await gh("api", `repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`, "-X", "DELETE");
      } else {
        await gh("api", `repos/${repo}/issues/${issueNumber}/reactions/${reactionId}`, "-X", "DELETE");
      }
    } catch (e) {
      console.error("Failed to remove reaction:", e);
    }
  }
}
