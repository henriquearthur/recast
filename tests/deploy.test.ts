import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const updater = resolve(import.meta.dir, "../deploy/update.sh");
const installer = resolve(import.meta.dir, "../deploy/install-auto-update.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recast-deploy-"));
  roots.push(root);
  const source = join(root, "source");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const dir of [source, state, bin, home]) mkdirSync(dir);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, RECAST_DEPLOY_DIR: state, REAL_BUN: process.execPath };
  function command(program: string, args: string[], cwd = source) {
    return spawnSync(program, args, { cwd, env, encoding: "utf8" });
  }
  function git(...args: string[]) {
    const result = command("git", args);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  function mock(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  }
  mock("bun", `if [[ $1 == -e || $1 == --env-file=* ]]; then exec "$REAL_BUN" "$@"; fi
if [[ $1 == install && -f dependency-failure ]]; then exit 1; fi
# Deploying only builds: type checking and tests are not a deployment gate.
if [[ $1 == test || ( $1 == run && $2 == typecheck ) ]]; then exit 1; fi
if [[ $1 == run && $2 == build && -f build-failure ]]; then exit 1; fi`);
  mock("systemctl", `echo "$*" >>"$RECAST_DEPLOY_DIR/service-actions"`);
  mock("loginctl", `echo yes`);
  mock("curl", `if [[ -f $RECAST_DEPLOY_DIR/active/startup-failure ]]; then echo '{"ok":false}'; else echo '{"ok":true}'; fi`);
  mock("sleep", ":");
  git("init", "-b", "main");
  writeFileSync(join(source, "app"), "first release\n");
  function commit() {
    git("add", ".");
    git("-c", "user.name=Deploy Test", "-c", "user.email=deploy@example.invalid", "commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  }
  const initial = commit();
  git("clone", "--bare", source, join(state, "repository.git"));
  const old = join(state, "releases", "initial");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, ".recast-commit"), `${initial}\n`);
  symlinkSync(old, join(state, "active"));
  return {
    source, state, home, old, command, git, commit, mock,
    run: (...args: string[]) => command("bash", [updater, ...args]),
    active: () => readlinkSync(join(state, "active")),
    actions: () => existsSync(join(state, "service-actions")) ? readFileSync(join(state, "service-actions"), "utf8") : "",
  };
}

test("deploys fetched main into an isolated release and leaves unchanged commits alone", () => {
  const f = fixture();
  writeFileSync(join(f.source, "app"), "next release\n");
  const candidate = f.commit();
  // Uncommitted development files must never be published.
  writeFileSync(join(f.source, "app"), "uncommitted development\n");
  expect(f.run().status).toBe(0);
  expect(readFileSync(join(f.active(), "app"), "utf8")).toBe("next release\n");
  expect(readFileSync(join(f.active(), ".recast-commit"), "utf8").trim()).toBe(candidate);
  expect(readlinkSync(join(f.state, "previous"))).toBe(f.old);
  expect(f.actions()).toBe("--user restart recast.service\n");
  expect(f.run().status).toBe(0);
  expect(f.actions()).toBe("--user restart recast.service\n");
});

test("rejects build errors before restart and permits an explicit retry", () => {
  const f = fixture();
  writeFileSync(join(f.source, "build-failure"), "");
  const candidate = f.commit();
  expect(f.run().status).toBe(1);
  expect(f.active()).toBe(f.old);
  expect(f.actions()).toBe("");
  expect(readFileSync(join(f.state, "rejected-commit"), "utf8").trim()).toBe(candidate);
  expect(f.run().status).toBe(0);
  expect(f.run("--retry-rejected").status).toBe(1);
  rmSync(join(f.source, "build-failure"));
  f.commit();
  expect(f.run().status).toBe(0);
  expect(existsSync(join(f.state, "rejected-commit"))).toBe(false);
});

test("rolls back when the health endpoint returns HTTP success with ok false", () => {
  const f = fixture();
  writeFileSync(join(f.source, "startup-failure"), "");
  f.commit();
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Previous release recovered");
  expect(f.active()).toBe(f.old);
  expect(f.actions()).toBe("--user restart recast.service\n--user restart recast.service\n");
  expect(f.run().status).toBe(0);
  expect(f.actions().split("restart")).toHaveLength(3);
});

test("dependency and fetch failures preserve the service and can be retried", () => {
  const f = fixture();
  writeFileSync(join(f.source, "dependency-failure"), "");
  f.commit();
  expect(f.run().status).toBe(1);
  expect(f.active()).toBe(f.old);
  expect(f.actions()).toBe("");
  expect(existsSync(join(f.state, "rejected-commit"))).toBe(false);
  f.git("--git-dir=" + join(f.state, "repository.git"), "remote", "set-url", "origin", join(f.state, "missing"));
  expect(f.run().status).not.toBe(0);
  expect(f.active()).toBe(f.old);
  expect(f.actions()).toBe("");
  f.git("--git-dir=" + join(f.state, "repository.git"), "remote", "set-url", "origin", f.source);
  rmSync(join(f.source, "dependency-failure"));
  f.commit();
  expect(f.run().status).toBe(0);
});

test("does not restart or fetch while another deploy owns the lock", () => {
  const f = fixture();
  const result = f.command("flock", [join(f.state, "update.lock"), "bash", updater]);
  expect(result.status).toBe(0);
  expect(f.active()).toBe(f.old);
  expect(f.actions()).toBe("");
});

test("installer renders units, uses the active release, and enables the timer", () => {
  const f = fixture();
  const deploy = join(f.source, "deploy");
  mkdirSync(deploy);
  for (const name of ["install-auto-update.sh", "update.sh", "recast-update.service", "recast-update.timer"]) {
    writeFileSync(join(deploy, name), readFileSync(resolve(installer, "..", name)));
  }
  f.commit();
  f.git("remote", "add", "origin", f.source);
  rmSync(join(f.state, "active"));
  const result = f.command("bash", [join(deploy, "install-auto-update.sh")]);
  expect(result.status).toBe(0);
  const units = join(f.home, ".config/systemd/user");
  expect(readFileSync(join(units, "recast-update.service"), "utf8")).not.toContain("@PUBLISHER@");
  expect(readFileSync(join(units, "recast-update.service"), "utf8")).toContain(resolve(Bun.which("node")!, ".."));
  expect(readFileSync(join(units, "recast.service.d/auto-update.conf"), "utf8")).toContain(`${f.state}/active`);
  expect(f.actions()).toContain("--user enable --now recast-update.timer");
  expect(existsSync(join(f.home, ".local/libexec/recast/update.sh"))).toBe(true);
});

test("installer restores the original service configuration on unhealthy startup", () => {
  const f = fixture();
  const deploy = join(f.source, "deploy");
  mkdirSync(deploy);
  for (const name of ["install-auto-update.sh", "update.sh", "recast-update.service", "recast-update.timer"]) {
    writeFileSync(join(deploy, name), readFileSync(resolve(installer, "..", name)));
  }
  f.commit();
  f.git("remote", "add", "origin", f.source);
  f.mock("curl", "echo '{\"ok\":false}'");
  const result = f.command("bash", [join(deploy, "install-auto-update.sh")]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("restored the previous service configuration");
  expect(existsSync(join(f.home, ".config/systemd/user/recast.service.d/auto-update.conf"))).toBe(false);
  expect(f.actions()).not.toContain("enable --now recast-update.timer");
  expect(f.actions().split("restart")).toHaveLength(3);
});
