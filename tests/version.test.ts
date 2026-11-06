import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = Bun.TOML.parse(await Bun.file(new URL("../mise.toml", import.meta.url)).text()) as {
  tasks: { up_version: { run: string } };
};

for (const [before, after] of [
  ["0.0.0", "0.0.1"],
  ["0.0.9", "0.1.0"],
  ["0.9.9", "1.0.0"],
  ["9.9.9", "10.0.0"],
]) {
  test(`version ${before} → ${after}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomad-version-"));
    try {
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "demo", version: before }));
      // mise 将 shebang 脚本作为临时文件运行；直接执行相同内容验证进位规则。
      await Bun.write(join(dir, "update.js"), config.tasks.up_version.run);
      const child = Bun.spawn([process.execPath, "update.js"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(await Bun.file(join(dir, "package.json")).json()).toEqual({
        name: "demo",
        version: after,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
