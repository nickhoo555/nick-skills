import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skillsRoot = path.join(root, "skills");
const readmePath = path.join(root, "README.md");
const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
const errors: string[] = [];

type Skill = {
  name: string;
  category: string;
  directoryPath: string;
  relativePath: string;
  internal: boolean;
};

type MarketplacePlugin = {
  name?: unknown;
  source?: unknown;
  skills?: unknown;
};

type Marketplace = {
  name?: unknown;
  plugins?: unknown;
};

async function findSkillFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(entryPath)));
    } else if (entry.name === "SKILL.md") {
      files.push(entryPath);
    }
  }

  return files;
}

function unquote(value: string): string {
  return value.replace(/^("|')|("|')$/g, "");
}

function parseSkill(filePath: string, contents: string): Skill | undefined {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!frontmatter) {
    errors.push(`${relativePath}: 缺少 YAML frontmatter`);
    return;
  }

  const lines = frontmatter[1].split(/\r?\n/);
  let name = "";
  let hasDescription = false;
  let inMetadata = false;
  let internal = false;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      inMetadata = trimmed === "metadata:";

      const nameMatch = trimmed.match(/^name:\s*(.+)$/);
      if (nameMatch) name = unquote(nameMatch[1].trim());
      if (/^description:\s*\S+/.test(trimmed)) hasDescription = true;
      continue;
    }

    if (inMetadata) {
      const internalMatch = trimmed.match(/^internal:\s*(true|false)$/);
      if (internalMatch) internal = internalMatch[1] === "true";
    }
  }

  if (!name) errors.push(`${relativePath}: 缺少 name`);
  if (!hasDescription) errors.push(`${relativePath}: 缺少 description`);
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push(`${relativePath}: name 必须使用小写 kebab-case`);
  }

  const segments = relativePath.split("/");
  const isExperimental = segments[1] === ".experimental";
  const expectedDepth = isExperimental ? 5 : 4;

  if (segments.length !== expectedDepth) {
    errors.push(
      `${relativePath}: Skill 必须位于 skills/<category>/<name>/ 或 skills/.experimental/<category>/<name>/`,
    );
  }

  const category = segments[isExperimental ? 2 : 1] ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) {
    errors.push(`${relativePath}: category 必须使用小写 kebab-case`);
  }

  const directoryName = segments.at(-2) ?? "";
  if (name && directoryName !== name) {
    errors.push(`${relativePath}: 目录名 ${directoryName} 与 name ${name} 不一致`);
  }

  if (isExperimental && !internal) {
    errors.push(`${relativePath}: 验证中的 Skill 必须设置 metadata.internal: true`);
  }
  if (!isExperimental && internal) {
    errors.push(`${relativePath}: 公开 Skill 不得设置 metadata.internal: true`);
  }

  return {
    name,
    category,
    directoryPath: path.posix.dirname(relativePath),
    relativePath,
    internal,
  };
}

const skillFiles = await findSkillFiles(skillsRoot);
const skills = (
  await Promise.all(
    skillFiles.map(async (filePath) =>
      parseSkill(filePath, await readFile(filePath, "utf8")),
    ),
  )
).filter((skill): skill is Skill => Boolean(skill));

const seenNames = new Map<string, string>();
for (const skill of skills) {
  const existing = seenNames.get(skill.name);
  if (existing) {
    errors.push(`${skill.relativePath}: name 与 ${existing} 重复`);
  } else {
    seenNames.set(skill.name, skill.relativePath);
  }
}

async function validateMarketplace(skills: Skill[]): Promise<void> {
  let marketplace: Marketplace;

  try {
    marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  } catch (error) {
    errors.push(
      `.claude-plugin/marketplace.json: 无法读取或解析 JSON（${error instanceof Error ? error.message : String(error)}）`,
    );
    return;
  }

  if (marketplace.name !== "nick-skills") {
    errors.push('.claude-plugin/marketplace.json: name 必须是 "nick-skills"');
  }

  if (!Array.isArray(marketplace.plugins)) {
    errors.push(".claude-plugin/marketplace.json: plugins 必须是数组");
    return;
  }

  const skillsByDirectory = new Map(
    skills.map((skill) => [skill.directoryPath, skill]),
  );
  const groupedDirectories = new Map<string, string>();
  const seenPluginNames = new Set<string>();

  for (const [index, rawPlugin] of marketplace.plugins.entries()) {
    if (!rawPlugin || typeof rawPlugin !== "object") {
      errors.push(`.claude-plugin/marketplace.json: plugins[${index}] 必须是对象`);
      continue;
    }

    const plugin = rawPlugin as MarketplacePlugin;
    const location = `.claude-plugin/marketplace.json: plugins[${index}]`;

    if (
      typeof plugin.name !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.name)
    ) {
      errors.push(`${location}.name 必须使用小写 kebab-case`);
      continue;
    }

    if (seenPluginNames.has(plugin.name)) {
      errors.push(`${location}.name ${plugin.name} 重复`);
    }
    seenPluginNames.add(plugin.name);

    if (plugin.source !== "./") {
      errors.push(`${location}.source 必须是 "./"`);
    }

    if (!Array.isArray(plugin.skills) || plugin.skills.length === 0) {
      errors.push(`${location}.skills 必须是非空数组`);
      continue;
    }

    for (const [skillIndex, rawSkillPath] of plugin.skills.entries()) {
      if (typeof rawSkillPath !== "string" || !rawSkillPath.startsWith("./skills/")) {
        errors.push(`${location}.skills[${skillIndex}] 必须是以 ./skills/ 开头的路径`);
        continue;
      }

      const directoryPath = path.posix.normalize(rawSkillPath.slice(2));
      const skill = skillsByDirectory.get(directoryPath);

      if (!skill) {
        errors.push(`${location}.skills[${skillIndex}] 指向不存在的 Skill：${rawSkillPath}`);
        continue;
      }

      const existingGroup = groupedDirectories.get(directoryPath);
      if (existingGroup) {
        errors.push(
          `${skill.relativePath}: 同时出现在 TUI 分组 ${existingGroup} 和 ${plugin.name}`,
        );
        continue;
      }
      groupedDirectories.set(directoryPath, plugin.name);

      if (plugin.name !== skill.category) {
        errors.push(
          `${skill.relativePath}: TUI 分组 ${plugin.name} 与 category ${skill.category} 不一致`,
        );
      }
    }
  }

  for (const skill of skills) {
    if (!groupedDirectories.has(skill.directoryPath)) {
      errors.push(`${skill.relativePath}: 未列入 TUI 分类 manifest`);
    }
  }
}

await validateMarketplace(skills);

const readme = await readFile(readmePath, "utf8");
const linkedSkills = [
  ...readme.matchAll(/\[([^\]]+)\]\((?:\.\/)?(skills\/[^)]+\/SKILL\.md)\)/g),
].map((match) => ({ label: match[1], path: match[2] }));
const linkedSkillPaths = new Set(linkedSkills.map((link) => link.path));

const publicSkills = skills.filter((skill) => !skill.internal);
const publicPaths = new Set(publicSkills.map((skill) => skill.relativePath));

for (const skill of publicSkills) {
  if (!linkedSkillPaths.has(skill.relativePath)) {
    errors.push(`${skill.relativePath}: 公开 Skill 未列入 README.md`);
  }
}

for (const linkedPath of linkedSkillPaths) {
  if (!publicPaths.has(linkedPath)) {
    errors.push(`README.md: ${linkedPath} 不是现有的公开 Skill`);
  }
}

const publicSkillsByPath = new Map(
  publicSkills.map((skill) => [skill.relativePath, skill]),
);
for (const link of linkedSkills) {
  const skill = publicSkillsByPath.get(link.path);
  if (skill && link.label !== `\`${skill.name}\`` && link.label !== skill.name) {
    errors.push(`README.md: ${link.path} 的链接文字必须是 Skill 名称 ${skill.name}`);
  }
}

if (errors.length > 0) {
  console.error("Skill validation failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Skill validation passed: ${publicSkills.length} public, ${skills.length - publicSkills.length} internal.`,
);
