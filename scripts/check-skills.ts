import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skillsRoot = path.join(root, "skills");
const readmePath = path.join(root, "README.md");
const errors: string[] = [];

type Skill = {
  name: string;
  relativePath: string;
  internal: boolean;
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
  const expectedDepth = isExperimental ? 4 : 3;

  if (segments.length !== expectedDepth) {
    errors.push(
      `${relativePath}: Skill 必须位于 skills/<name>/ 或 skills/.experimental/<name>/`,
    );
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

  return { name, relativePath, internal };
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

const readme = await readFile(readmePath, "utf8");
const linkedSkillPaths = new Set(
  [...readme.matchAll(/\]\((?:\.\/)?(skills\/[^)]+\/SKILL\.md)\)/g)].map(
    (match) => match[1],
  ),
);

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

if (errors.length > 0) {
  console.error("Skill validation failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Skill validation passed: ${publicSkills.length} public, ${skills.length - publicSkills.length} internal.`,
);
