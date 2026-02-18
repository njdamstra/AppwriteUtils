import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const root = process.cwd();

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));

const writeJson = (relativePath, data) => {
  fs.writeFileSync(
    path.join(root, relativePath),
    JSON.stringify(data, null, 2) + "\n"
  );
};

const publishList = (process.env.PUBLISH_PACKAGES || "all")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const shouldUpdate = (pkgName) =>
  publishList.includes("all") || publishList.includes(pkgName);

const localVersions = {
  "@njdamstra/appwrite-utils": readJson("packages/appwrite-utils/package.json").version,
  "@njdamstra/appwrite-utils-helpers": readJson("packages/appwrite-utils-helpers/package.json").version,
};

const getRemoteVersion = (packageName) => {
  try {
    const output = execSync(`npm view ${packageName} version`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim();
  } catch {
    return null;
  }
};

const resolveDepVersion = (depName) => {
  if (shouldUpdate(depName)) {
    return localVersions[depName];
  }
  return getRemoteVersion(depName) || localVersions[depName];
};

const setDepVersion = (pkg, depName, version) => {
  if (pkg.dependencies && depName in pkg.dependencies && version) {
    pkg.dependencies[depName] = `^${version}`;
  }
};

const packagesToUpdate = [
  { name: "@njdamstra/appwrite-utils-helpers", path: "packages/appwrite-utils-helpers/package.json" },
  { name: "@njdamstra/appwrite-utils-cli", path: "packages/appwrite-utils-cli/package.json" },
  { name: "@njdamstra/appwrite-utils-mcp", path: "packages/appwrite-utils-mcp/package.json" },
];

for (const pkgInfo of packagesToUpdate) {
  const pkg = readJson(pkgInfo.path);
  if (shouldUpdate(pkgInfo.name)) {
    const utilsVersion = resolveDepVersion("@njdamstra/appwrite-utils");
    const helpersVersion = resolveDepVersion("@njdamstra/appwrite-utils-helpers");
    setDepVersion(pkg, "@njdamstra/appwrite-utils", utilsVersion);
    setDepVersion(pkg, "@njdamstra/appwrite-utils-helpers", helpersVersion);
    writeJson(pkgInfo.path, pkg);
  }
}
