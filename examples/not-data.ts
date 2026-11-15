// A policy that is code, not data: it reads the environment. Folding refuses
// it with the line; running it accepts whatever the environment said.
export default {
  nodes: {
    "acme/api": {
      kind: "project",
      projectSettings: { removeSourceBranchAfterMerge: process.env.CLEANUP === "1" },
    },
  },
};
