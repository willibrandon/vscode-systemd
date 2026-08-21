import { describe, expect, it } from "vitest";
import { runValidator, validationInvocation } from "../src/external-validator.js";

const executables = {
  systemdAnalyze: "/usr/bin/systemd-analyze",
  quadletGenerator: "/usr/libexec/podman/quadlet",
  mkosi: "/usr/bin/mkosi",
};

describe("installed validator policy", () => {
  it("uses systemd-analyze verify for unit files", () => {
    expect(validationInvocation("systemd-unit", "/workspace/demo.service", executables)).toEqual({
      executable: "/usr/bin/systemd-analyze",
      arguments: ["verify", "/workspace/demo.service"],
      cwd: "/workspace",
      label: "systemd-analyze verify",
    });
  });

  it("uses an isolated Quadlet generator dry run", () => {
    expect(
      validationInvocation("podman-quadlet", "/workspace/demo.container", executables),
    ).toEqual({
      executable: "/usr/libexec/podman/quadlet",
      arguments: ["-dryrun"],
      cwd: "/workspace",
      label: "Quadlet generator dry run",
      environment: { QUADLET_UNIT_DIRS: "/workspace" },
    });
  });

  it("uses mkosi summary from the configuration directory", () => {
    expect(validationInvocation("mkosi", "/workspace/mkosi.conf", executables)).toEqual({
      executable: "/usr/bin/mkosi",
      arguments: ["--directory", "/workspace", "summary"],
      cwd: "/workspace",
      label: "mkosi summary",
    });
  });

  it("does not invent an unsafe validator for unsupported dialects", () => {
    expect(
      validationInvocation("systemd-udev-rules", "/workspace/90-demo.rules", executables),
    ).toBeUndefined();
  });

  it("refuses to spawn when the workspace is untrusted", async () => {
    const controller = new AbortController();
    await expect(
      runValidator(
        {
          executable: process.execPath,
          arguments: ["--version"],
          cwd: process.cwd(),
          label: "test",
        },
        controller.signal,
        () => false,
      ),
    ).rejects.toThrow("Trust this workspace");
  });

  it("runs a bounded process without a shell", async () => {
    const controller = new AbortController();
    const result = await runValidator(
      {
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('validated')"],
        cwd: process.cwd(),
        label: "test validator",
      },
      controller.signal,
      () => true,
    );
    expect(result).toMatchObject({
      label: "test validator",
      exitCode: 0,
      stdout: "validated",
      timedOut: false,
      truncated: false,
      cancelled: false,
    });
  });

  it("returns immediately when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runValidator(
        {
          executable: "/definitely/not/executed",
          arguments: [],
          cwd: process.cwd(),
          label: "cancelled validator",
        },
        controller.signal,
        () => true,
      ),
    ).resolves.toMatchObject({
      exitCode: null,
      stdout: "",
      stderr: "",
      cancelled: true,
      timedOut: false,
      truncated: false,
    });
  });

  it("captures stderr and nonzero exits", async () => {
    const result = await runValidator(
      {
        executable: process.execPath,
        arguments: ["-e", "process.stderr.write('invalid'); process.exit(7)"],
        cwd: process.cwd(),
        label: "failing validator",
      },
      new AbortController().signal,
      () => true,
    );
    expect(result).toMatchObject({ exitCode: 7, stderr: "invalid", stdout: "" });
  });

  it("cancels an active process tree", async () => {
    const controller = new AbortController();
    const validation = runValidator(
      {
        executable: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        label: "long validator",
      },
      controller.signal,
      () => true,
    );
    setTimeout(() => controller.abort(), 30);
    await expect(validation).resolves.toMatchObject({ cancelled: true, timedOut: false });
  });

  it.skipIf(process.platform === "win32")(
    "force-kills a validator that ignores graceful termination",
    async () => {
      const controller = new AbortController();
      const validation = runValidator(
        {
          executable: process.execPath,
          arguments: [
            "-e",
            "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
          ],
          cwd: process.cwd(),
          label: "stubborn validator",
        },
        controller.signal,
        () => true,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(validation).resolves.toMatchObject({
        stdout: "ready",
        cancelled: true,
        timedOut: false,
      });
    },
  );

  it("truncates excessive combined output and terminates the process", async () => {
    const result = await runValidator(
      {
        executable: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write('x'.repeat(300 * 1024)); setInterval(() => {}, 1000)",
        ],
        cwd: process.cwd(),
        label: "noisy validator",
      },
      new AbortController().signal,
      () => true,
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(256 * 1024);
  });

  it("reports spawn failures", async () => {
    await expect(
      runValidator(
        {
          executable: "/definitely/not/a/validator",
          arguments: [],
          cwd: process.cwd(),
          label: "missing validator",
        },
        new AbortController().signal,
        () => true,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects results if trust is revoked while the process runs", async () => {
    let checks = 0;
    await expect(
      runValidator(
        {
          executable: process.execPath,
          arguments: ["-e", "process.exit(0)"],
          cwd: process.cwd(),
          label: "trust validator",
        },
        new AbortController().signal,
        () => {
          checks += 1;
          return checks === 1;
        },
      ),
    ).rejects.toThrow("trust was revoked");
  });
});
