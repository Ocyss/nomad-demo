import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = Bun.TOML.parse(await Bun.file(new URL("../mise.toml", import.meta.url)).text()) as {
  tasks: { deploy: { run: string } };
};

async function deploy(version?: string, missing = false, pullFails = false) {
  const dir = await mkdtemp(join(tmpdir(), "nomad-deploy-"));
  try {
    await Bun.write(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    for (const [name, script] of Object.entries({
      docker:
        '#!/bin/sh\nprintf "docker %s\\n" "$*" >> "$CALLS"\nif [ "$1 $2" = "image inspect" ]; then exit "$MISSING"; fi\nexit "$PULL_FAILS"\n',
      nomad: '#!/bin/sh\nprintf "nomad %s\\n" "$*" >> "$CALLS"\n',
      jq: '#!/bin/sh\nprintf "1.2.3\\n"\n',
    })) {
      const path = join(dir, name);
      await Bun.write(path, script);
      await chmod(path, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      IMAGE_NAME: "nomad-demo",
      CALLS: join(dir, "calls"),
      MISSING: String(Number(missing)),
      PULL_FAILS: String(Number(pullFails)),
    };
    delete (env as Record<string, string | undefined>).usage_version;
    if (version !== undefined) Object.assign(env, { usage_version: version });
    const child = Bun.spawn(["bash", "-c", config.tasks.deploy.run], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    const calls = (await Bun.file(join(dir, "calls")).exists())
      ? await Bun.file(join(dir, "calls")).text()
      : "";
    const pkg = await Bun.file(join(dir, "package.json")).json();
    return { code, calls, pkg };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("deploy defaults to package version without building", async () => {
  const result = await deploy();
  expect(result.code).toBe(0);
  expect(result.calls).toContain("image=nomad-demo:1.2.3 -var version=1.2.3");
  expect(result.calls).not.toContain("docker pull");
});

test("deploy can roll back by tag without changing package.json", async () => {
  const result = await deploy("0.0.9");
  expect(result.code).toBe(0);
  expect(result.calls).toContain("image=nomad-demo:0.0.9 -var version=0.0.9");
  expect(result.pkg.version).toBe("1.2.3");
});

test("missing images are pulled before deployment", async () => {
  const result = await deploy("0.0.9", true);
  expect(result.code).toBe(0);
  expect(result.calls).toContain("docker pull nomad-demo:0.0.9\nnomad job run");
});

test("failed image pull prevents a Nomad submission", async () => {
  const result = await deploy("0.0.9", true, true);
  expect(result.code).not.toBe(0);
  expect(result.calls).not.toContain("nomad job run");
});

test("deploy accepts arbitrary image tags without version validation", async () => {
  const result = await deploy("demo-preview");
  expect(result.code).toBe(0);
  expect(result.calls).toContain("image=nomad-demo:demo-preview -var version=demo-preview");
});
