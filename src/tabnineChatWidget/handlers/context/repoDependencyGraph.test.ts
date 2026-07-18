// eslint-disable-next-line import/no-extraneous-dependencies
import { expect } from "chai";
import type { ContextTypeData } from "./enrichingContextTypes";
import {
  buildDependencyOrder,
  extractImportSpecifiers,
  pruneToSignatures,
  resolveDependencyPath,
  selectWithinBudget,
} from "./repoDependencyGraph";

describe("repo dependency graph (HCP-style context pruning)", () => {
  describe("extractImportSpecifiers", () => {
    it("captures JS/TS import/export and require specifiers", () => {
      const source = [
        'import a from "./a";',
        'import { b } from "./b";',
        'const c = require("./c");',
        'const d = import("./d");',
        'export { e } from "./e";',
      ].join("\n");
      expect(extractImportSpecifiers(source).sort()).to.deep.equal(
        ["./a", "./b", "./c", "./d", "./e"].sort()
      );
    });

    it("captures Python import forms", () => {
      const source = "import os\nfrom foo.bar import thing\nimport baz";
      expect(extractImportSpecifiers(source).sort()).to.deep.equal(
        ["baz", "foo.bar", "os"].sort()
      );
    });

    it("ignores external protocol specifiers", () => {
      const source =
        'import x from "https://example.com/x";\nimport y from "vscode:foo";';
      expect(extractImportSpecifiers(source)).to.deep.equal([]);
    });
  });

  describe("resolveDependencyPath", () => {
    const candidates = [
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/sub/c.ts",
      "/repo/src/utils/index.ts",
    ];

    it("resolves relative specifiers with extension inference", () => {
      expect(
        resolveDependencyPath("./a", "/repo/src/main.ts", candidates)
      ).to.equal("/repo/src/a.ts");
    });

    it("resolves directory imports to index files", () => {
      expect(
        resolveDependencyPath("./utils", "/repo/src/main.ts", candidates)
      ).to.equal("/repo/src/utils/index.ts");
    });

    it("resolves sibling and parent relative paths", () => {
      expect(
        resolveDependencyPath("./c", "/repo/src/sub/x.ts", candidates)
      ).to.equal("/repo/src/sub/c.ts");
      expect(
        resolveDependencyPath("../a", "/repo/src/sub/x.ts", candidates)
      ).to.equal("/repo/src/a.ts");
    });
  });

  describe("buildDependencyOrder", () => {
    it("orders dependencies by relevance depth, excluding the focal file", () => {
      const sources = new Map<string, string>([
        ["/repo/main.ts", 'import { a } from "./a";'],
        ["/repo/a.ts", 'import { b } from "./b";'],
        ["/repo/b.ts", "export const b = 1;"],
      ]);
      const order = buildDependencyOrder("/repo/main.ts", sources);
      const paths = order.map((dep) => dep.path);

      expect(paths).to.include("/repo/a.ts");
      expect(paths).to.include("/repo/b.ts");
      expect(paths).to.not.include("/repo/main.ts");

      const direct = order.find((dep) => dep.path === "/repo/a.ts");
      const transitive = order.find((dep) => dep.path === "/repo/b.ts");
      expect(direct?.depth).to.equal(1);
      expect(transitive?.depth).to.equal(2);
      // direct dependency precedes its own dependency's... it appears first
      expect(paths.indexOf("/repo/a.ts")).to.be.lessThan(
        paths.indexOf("/repo/b.ts")
      );
    });

    it("tolerates dependency cycles without looping", () => {
      const sources = new Map<string, string>([
        ["/repo/main.ts", 'import { a } from "./a";'],
        ["/repo/a.ts", 'import { main } from "./main";'],
      ]);
      const order = buildDependencyOrder("/repo/main.ts", sources);
      expect(order.map((dep) => dep.path)).to.deep.equal(["/repo/a.ts"]);
    });
  });

  describe("pruneToSignatures", () => {
    it("keeps signatures and drops bodies", () => {
      const source = [
        'import { x } from "./x";',
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export class Calc {",
        "  run() { return 0; }",
        "}",
      ].join("\n");
      const pruned = pruneToSignatures(source);
      expect(pruned).to.include('import { x } from "./x";');
      expect(pruned).to.include(
        "export function add(a: number, b: number): number { ... }"
      );
      expect(pruned).to.include("export class Calc { ... }");
      expect(pruned).to.not.include("return a + b;");
    });
  });

  describe("selectWithinBudget", () => {
    it("keeps direct deps full and prunes transitive deps when over budget", () => {
      const direct = "export const a = 1;\n".repeat(20); // ~400 chars
      const transitive = `export function big() { /* ${"x".repeat(400)} */ }\n`;
      const sources = new Map<string, string>([
        ["/repo/a.ts", direct],
        ["/repo/b.ts", transitive],
      ]);
      const ordered = [
        { path: "/repo/a.ts", depth: 1 },
        { path: "/repo/b.ts", depth: 2 },
      ];
      const selected = selectWithinBudget(ordered, sources, direct.length + 50);

      const directEntry = selected.find((dep) => dep.path === "/repo/a.ts");
      const transitiveEntry = selected.find((dep) => dep.path === "/repo/b.ts");
      expect(directEntry?.pruned).to.equal(false);
      expect(directEntry?.relevance).to.equal("direct");
      // transitive dep no longer fits as a full body; if kept it is pruned
      if (transitiveEntry) {
        expect(transitiveEntry.pruned).to.equal(true);
        expect(transitiveEntry.relevance).to.equal("transitive");
      }
    });

    it("keeps everything full when the budget is generous", () => {
      const sources = new Map<string, string>([
        ["/repo/a.ts", "export const a = 1;"],
        ["/repo/b.ts", "export const b = 2;"],
      ]);
      const ordered = [
        { path: "/repo/a.ts", depth: 1 },
        { path: "/repo/b.ts", depth: 2 },
      ];
      const selected = selectWithinBudget(ordered, sources, 10000);
      expect(selected.every((dep) => !dep.pruned)).to.equal(true);
      expect(selected.map((dep) => dep.path)).to.deep.equal([
        "/repo/a.ts",
        "/repo/b.ts",
      ]);
    });
  });

  describe("enriching context contract", () => {
    it("produces a RepoDependencies entry conforming to ContextTypeData", () => {
      const sources = new Map<string, string>([
        ["/repo/main.ts", 'import { a } from "./a";'],
        ["/repo/a.ts", "export const a = 1;"],
      ]);
      const ordered = buildDependencyOrder("/repo/main.ts", sources);
      const dependencies = selectWithinBudget(ordered, sources, 10000);

      const contextData: ContextTypeData = {
        type: "RepoDependencies",
        dependencies,
      };
      expect(contextData.type).to.equal("RepoDependencies");
      expect(contextData.dependencies).to.have.length.greaterThan(0);
      expect(contextData.dependencies[0].path).to.equal("/repo/a.ts");
    });
  });
});
