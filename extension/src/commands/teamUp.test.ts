import { expect, test } from "bun:test";

import {
  buildAwakenMemberCommand,
  buildTeamUpCommand,
  parseCharterSession,
  resolveInstanceSession,
} from "./teamUpModel";

test("parseCharterSession: reads the session field from a charter yaml", () => {
  const yaml = [
    "name: brew",
    "description: some team",
    "session: brew",
    "members:",
    "  - role: bob",
  ].join("\n");
  expect(parseCharterSession(yaml)).toBe("brew");
});

test("parseCharterSession: tolerates extra whitespace + trailing comment", () => {
  expect(parseCharterSession("session:   carbon   ")).toBe("carbon");
  expect(parseCharterSession("session: oracle-council # pinned")).toBe("oracle-council");
});

test("parseCharterSession: null when no session field", () => {
  expect(parseCharterSession("name: brew\nmembers:\n  - role: bob")).toBeNull();
  expect(parseCharterSession("")).toBeNull();
});

test("resolveInstanceSession: base free → use base, not minted", () => {
  const r = resolveInstanceSession("brew", () => false);
  expect(r).toEqual({ session: "brew", minted: false });
});

test("resolveInstanceSession: base busy → mint the first free -N instance", () => {
  // brew + brew-2 taken, brew-3 free
  const taken = new Set(["brew", "brew-2"]);
  const r = resolveInstanceSession("brew", (s) => taken.has(s));
  expect(r).toEqual({ session: "brew-3", minted: true });
});

test("resolveInstanceSession: mirrors /orches — walks base-2..base-9", () => {
  const taken = new Set(["brew", "brew-2", "brew-3", "brew-4"]);
  const r = resolveInstanceSession("brew", (s) => taken.has(s));
  expect(r).toEqual({ session: "brew-5", minted: true });
});

test("buildTeamUpCommand: bootstrap, sequential per-member wake, rename short, attach", () => {
  expect(buildTeamUpCommand("brew", "brew-2", "/home/u/soulbrew", ["bob", "jack"])).toBe(
    "tmux new-session -A -d -s 'brew-2' -n _boot -c '/home/u/soulbrew' && { " +
      "maw team up 'brew' --session 'brew-2' --force --only 'bob' ; " +
      "maw team up 'brew' --session 'brew-2' --force --only 'jack' ; " +
      "for w in $(tmux list-windows -t '=brew-2' -F '#{window_name}'); do " +
      'tmux rename-window -t "=brew-2:$w" "${w#*-}" 2>/dev/null ; done ; ' +
      "tmux kill-window -t '=brew-2:_boot' 2>/dev/null ; " +
      "tmux attach -t '=brew-2' ; }",
  );
});

test("buildTeamUpCommand: per-member models → /model sent into each pane after wake, before attach", () => {
  const cmd = buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob", "john"], {
    bob: "claude-sonnet-5",
    john: "claude-haiku-4-5",
  });
  expect(cmd).toContain("tmux send-keys -t '=brew:bob' '/model claude-sonnet-5' Enter");
  expect(cmd).toContain("tmux send-keys -t '=brew:john' '/model claude-haiku-4-5' Enter");
  expect(cmd.indexOf("/model")).toBeLessThan(cmd.indexOf("tmux attach")); // set before the user lands
});

test("buildTeamUpCommand: member without a configured model gets no /model", () => {
  const cmd = buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob", "mike"], {
    bob: "claude-sonnet-5",
  });
  expect(cmd).toContain("'=brew:bob' '/model claude-sonnet-5'");
  expect(cmd).not.toContain("=brew:mike");
});

test("buildTeamUpCommand: unsafe model string is dropped (no injection)", () => {
  const cmd = buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob"], {
    bob: "x; rm -rf /",
  });
  expect(cmd).not.toContain("/model");
  expect(cmd).not.toContain("rm -rf");
});

test("buildTeamUpCommand: no models arg → unchanged command (backward compatible)", () => {
  const cmd = buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob"]);
  expect(cmd).not.toContain("/model");
});

test("buildTeamUpCommand: empty roster → single plain up (charter decides)", () => {
  expect(buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", [])).toBe(
    "tmux new-session -A -d -s 'brew' -n _boot -c '/home/u/soulbrew' && { " +
      "maw team up 'brew' --session 'brew' --force ; " +
      "for w in $(tmux list-windows -t '=brew' -F '#{window_name}'); do " +
      'tmux rename-window -t "=brew:$w" "${w#*-}" 2>/dev/null ; done ; ' +
      "tmux kill-window -t '=brew:_boot' 2>/dev/null ; " +
      "tmux attach -t '=brew' ; }",
  );
});

// --- view setting: chat hosts the session itself, so the bootstrap must NOT attach ---

test("buildTeamUpCommand: attach=false → wake + rename + kill _boot, but no tmux attach", () => {
  const cmd = buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob", "jack"], {}, false);
  expect(cmd).toContain("maw team up 'brew' --session 'brew' --force --only 'bob'");
  expect(cmd).toContain("maw team up 'brew' --session 'brew' --force --only 'jack'");
  expect(cmd).toContain("tmux kill-window -t '=brew:_boot'");
  expect(cmd).not.toContain("tmux attach");
  expect(cmd.endsWith("}")).toBe(true); // brace group still closes → `&& { … }` stays valid
});

test("buildTeamUpCommand: attach=false keeps the per-member /model sends", () => {
  const cmd = buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob"], { bob: "claude-sonnet-5" }, false);
  expect(cmd).toContain("tmux send-keys -t '=brew:bob' '/model claude-sonnet-5' Enter");
  expect(cmd).not.toContain("tmux attach");
});

test("buildAwakenMemberCommand: attach=false → /awaken still fires, nothing attaches", () => {
  const cmd = buildAwakenMemberCommand("brew", "brew", "/home/u/soulbrew", "newbie", false);
  expect(cmd).toContain("tmux send-keys -t '=brew:newbie' '/awaken' Enter");
  expect(cmd).not.toContain("tmux attach");
  expect(cmd.endsWith("}")).toBe(true);
});

test("buildTeamUpCommand / buildAwakenMemberCommand: attach defaults to true (native unchanged)", () => {
  expect(buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", ["bob"])).toContain("tmux attach");
  expect(buildAwakenMemberCommand("brew", "brew", "/home/u/soulbrew", "bob")).toContain("tmux attach");
});

test("buildAwakenMemberCommand: wakes only the one oracle, then fires /awaken before attach", () => {
  const cmd = buildAwakenMemberCommand("brew", "brew", "/home/u/soulbrew", "newbie");
  // only this oracle woken — the rest of the team is untouched
  expect(cmd).toContain("maw team up 'brew' --session 'brew' --force --only 'newbie'");
  expect((cmd.match(/maw team up/g) || []).length).toBe(1);
  // /awaken fires into the woken window, and BEFORE the (blocking) attach
  expect(cmd).toContain("tmux send-keys -t '=brew:newbie' '/awaken' Enter");
  expect(cmd.indexOf("/awaken")).toBeLessThan(cmd.indexOf("tmux attach"));
});
