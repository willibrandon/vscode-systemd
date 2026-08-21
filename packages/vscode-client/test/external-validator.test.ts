import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hardenInvocationForCapabilities,
  runValidator,
  validationInvocation,
} from "../src/external-validator.js";

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
      staging: {
        kind: "systemd-unit",
        sourcePath: "/workspace/demo.service",
        sourceRoot: "/workspace",
      },
      capabilityPolicy: "systemd-unit",
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
      staging: {
        kind: "quadlet",
        sourcePath: "/workspace/demo.container",
        sourceRoot: "/workspace",
      },
      capabilityPolicy: "quadlet",
    });
  });

  it("uses mkosi summary from the configuration directory", () => {
    expect(validationInvocation("mkosi", "/workspace/mkosi.conf", executables)).toEqual({
      executable: "/usr/bin/mkosi",
      arguments: ["--no-pager", "--directory", "/workspace", "summary"],
      cwd: "/workspace",
      label: "mkosi summary",
      staging: {
        kind: "mkosi",
        sourcePath: "/workspace/mkosi.conf",
        sourceRoot: "/workspace",
      },
      capabilityPolicy: "mkosi",
    });
  });

  it("uses the owning root for drop-ins and nested mkosi configuration", () => {
    expect(
      validationInvocation("systemd-unit", "/workspace/demo.service.d/10-local.conf", executables)
        ?.staging?.sourceRoot,
    ).toBe("/workspace");
    expect(
      validationInvocation(
        "mkosi",
        "/workspace/mkosi.profiles/development/profile.conf",
        executables,
      )?.staging?.sourceRoot,
    ).toBe("/workspace");
  });

  it("does not invent an unsafe validator for unsupported dialects", () => {
    expect(
      validationInvocation("systemd-udev-rules", "/workspace/90-demo.rules", executables),
    ).toBeUndefined();
  });

  it("requires and applies explicit systemd verification safety flags", () => {
    const invocation = validationInvocation("systemd-unit", "/workspace/demo.service", executables);
    if (invocation === undefined) throw new Error("systemd invocation was not created.");
    expect(
      hardenInvocationForCapabilities(
        invocation,
        "systemd-unit",
        "--man[=BOOL] --generators[=BOOL] --recursive-errors=MODE",
      ),
    ).toMatchObject({
      arguments: [
        "--man=no",
        "--generators=no",
        "--recursive-errors=no",
        "verify",
        "/workspace/demo.service",
      ],
      environment: {
        SYSTEMD_ENVIRONMENT_GENERATOR_PATH: "",
        SYSTEMD_GENERATOR_PATH: "",
        SYSTEMD_UNIT_PATH: "/workspace",
      },
    });
    expect(() =>
      hardenInvocationForCapabilities(invocation, "systemd-unit", "--man[=BOOL]"),
    ).toThrow("required safe verification flags");
  });

  it("permits only source-audited mkosi versions with a non-paging summary", () => {
    const invocation = validationInvocation("mkosi", "/workspace/mkosi.conf", executables);
    if (invocation === undefined) throw new Error("mkosi invocation was not created.");
    expect(
      hardenInvocationForCapabilities(
        invocation,
        "mkosi",
        "--directory=PATH --no-pager summary",
        "mkosi 26.1",
      ),
    ).toBe(invocation);
    expect(() =>
      hardenInvocationForCapabilities(invocation, "mkosi", "--directory=PATH summary", "mkosi 26"),
    ).toThrow("safe non-paging summary interface");
    expect(() =>
      hardenInvocationForCapabilities(
        invocation,
        "mkosi",
        "--directory=PATH --no-pager summary",
        "mkosi 27",
      ),
    ).toThrow("source-audited versions 16 through 26");
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

  it("stages related unit files, scrubs the host environment, and remaps private paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "systemd-validator-test-"));
    const source = join(workspace, "demo.service");
    const related = join(workspace, "other.service");
    const ignored = join(workspace, "notes.txt");
    const secretName = "VSCODE_SYSTEMD_VALIDATOR_TEST_SECRET";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-leak";
    try {
      await Promise.all([
        writeFile(source, "[Service]\nExecStart=/bin/true\n"),
        writeFile(related, "[Unit]\nDescription=Related\n"),
        writeFile(ignored, "not configuration\n"),
      ]);
      const result = await runValidator(
        {
          executable: process.execPath,
          arguments: [
            "-e",
            [
              'const fs = require("node:fs");',
              "const target = process.argv[1];",
              'fs.appendFileSync(target, "# staged mutation\\n");',
              "process.stdout.write(JSON.stringify({",
              '  content: fs.readFileSync(target, "utf8"),',
              "  cwd: process.cwd(),",
              "  entries: fs.readdirSync(process.cwd()).sort(),",
              "  home: process.env.HOME,",
              "  secret: process.env.VSCODE_SYSTEMD_VALIDATOR_TEST_SECRET ?? null,",
              "  unitPath: process.env.SYSTEMD_UNIT_PATH,",
              "}));",
            ].join("\n"),
            source,
          ],
          cwd: workspace,
          label: "staged systemd validator",
          environment: { SYSTEMD_UNIT_PATH: workspace },
          staging: { kind: "systemd-unit", sourcePath: source, sourceRoot: workspace },
        },
        new AbortController().signal,
        () => true,
      );
      const output = JSON.parse(result.stdout) as {
        readonly content: string;
        readonly cwd: string;
        readonly entries: readonly string[];
        readonly home: string;
        readonly secret: string | null;
        readonly unitPath: string;
      };
      expect(output.content).toContain("# staged mutation");
      expect(output.cwd).toBe(workspace);
      expect(output.entries).toEqual(["demo.service", "other.service"]);
      expect(output.home).toBe("<validation>/home");
      expect(output.secret).toBeNull();
      expect(output.unitPath).toBe(workspace);
      expect(await readFile(source, "utf8")).not.toContain("staged mutation");
      expect(await readFile(ignored, "utf8")).toBe("not configuration\n");
    } finally {
      if (previousSecret === undefined) Reflect.deleteProperty(process.env, secretName);
      else process.env[secretName] = previousSecret;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "capability-probes Quadlet and stages only related files",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "quadlet-validator-test-"));
      const source = join(workspace, "demo.container");
      const dropInDirectory = join(workspace, "demo.container.d");
      const executable = join(workspace, "quadlet-probe.mjs");
      try {
        await mkdir(dropInDirectory);
        await Promise.all([
          writeFile(source, "[Container]\nImage=example.test/demo\n"),
          writeFile(join(workspace, "shared.network"), "[Network]\n"),
          writeFile(join(dropInDirectory, "10-local.conf"), "[Container]\nAutoUpdate=registry\n"),
          writeFile(join(workspace, "ignored.txt"), "ignored\n"),
          writeFile(
            executable,
            [
              "#!/usr/bin/env node",
              'const fs = await import("node:fs");',
              'const path = await import("node:path");',
              'if (process.argv.includes("-h")) { console.log("-dryrun"); process.exit(0); }',
              "const root = process.env.QUADLET_UNIT_DIRS;",
              "const files = fs.readdirSync(root).sort();",
              'const dropIns = fs.readdirSync(path.join(root, "demo.container.d")).sort();',
              "process.stdout.write(JSON.stringify({ root, files, dropIns }));",
              "",
            ].join("\n"),
          ),
        ]);
        await chmod(executable, 0o700);
        const base = validationInvocation("podman-quadlet", source, executables);
        if (base === undefined) throw new Error("Quadlet invocation was not created.");
        const result = await runValidator(
          { ...base, executable },
          new AbortController().signal,
          () => true,
        );
        const output = JSON.parse(result.stdout) as {
          readonly root: string;
          readonly files: readonly string[];
          readonly dropIns: readonly string[];
        };
        expect(output.root).toBe(workspace);
        expect(output.files).toEqual(["demo.container", "demo.container.d", "shared.network"]);
        expect(output.dropIns).toEqual(["10-local.conf"]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("rejects a Quadlet executable without an advertised dry-run interface", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "quadlet-capability-test-"));
    const source = join(workspace, "demo.container");
    try {
      await writeFile(source, "[Container]\nImage=example.test/demo\n");
      const base = validationInvocation("podman-quadlet", source, executables);
      if (base === undefined) throw new Error("Quadlet invocation was not created.");
      await expect(
        runValidator(
          { ...base, executable: process.execPath },
          new AbortController().signal,
          () => true,
        ),
      ).rejects.toThrow("does not advertise safe -dryrun support");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an oversized staged source before starting the validator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "systemd-size-test-"));
    const source = join(workspace, "large.service");
    try {
      await writeFile(source, Buffer.alloc(2 * 1024 * 1024 + 1));
      const invocation = validationInvocation("systemd-unit", source, executables);
      if (invocation === undefined) throw new Error("systemd invocation was not created.");
      await expect(
        runValidator(
          { ...invocation, executable: process.execPath },
          new AbortController().signal,
          () => true,
        ),
      ).rejects.toThrow("exceeds the 2 MiB staging limit");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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

  it("rechecks trust after preparing policy and after process completion", async () => {
    const invocation = {
      executable: process.execPath,
      arguments: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      label: "trust phases",
    };
    let policyChecks = 0;
    await expect(
      runValidator(invocation, new AbortController().signal, () => {
        policyChecks += 1;
        return policyChecks < 3;
      }),
    ).rejects.toThrow("trust was revoked");

    let resultChecks = 0;
    await expect(
      runValidator(invocation, new AbortController().signal, () => {
        resultChecks += 1;
        return resultChecks < 4;
      }),
    ).rejects.toThrow("trust was revoked");
  });

  it("rejects a staging source outside its declared configuration root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "systemd-root-test-"));
    const source = join(workspace, "demo.service");
    try {
      await writeFile(source, "[Service]\nExecStart=/bin/true\n");
      await expect(
        runValidator(
          {
            executable: process.execPath,
            arguments: ["--version"],
            cwd: workspace,
            label: "invalid staging root",
            staging: {
              kind: "systemd-unit",
              sourcePath: source,
              sourceRoot: join(workspace, "different-root"),
            },
          },
          new AbortController().signal,
          () => true,
        ),
      ).rejects.toThrow("must be contained");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
