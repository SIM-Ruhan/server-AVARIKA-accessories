import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
function check(dir) {
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, file.name);
    if (file.isDirectory()) check(path);
    else if (path.endsWith(".js"))
      execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
  }
}
check("src");
check("scripts");
check("test");
console.log("JavaScript syntax checks passed.");
