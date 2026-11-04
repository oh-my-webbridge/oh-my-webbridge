/** Repository facts shared by the site and the build scripts; it reads no environment variables. */
export const repository = {
  owner: "oh-my-webbridge",
  name: "oh-my-webbridge",
  branch: "main",
  contentDir: "docs/content/docs",
} as const;
export const repositoryUrl = `https://github.com/${repository.owner}/${repository.name}`;
