import { describe, expect, it } from "vitest";
import { githubCluster, looseRepoClause } from "../src/lib/session-facts.ts";

const gh = {
  repo: null as string | null,
  branch: null as string | null,
  credential: "none" as const,
  merge: false,
  onBehalfOf: null as string | null,
};

describe("githubCluster / looseRepoClause", () => {
  it("says no repository once when neither the floppy nor GitHub has one", () => {
    const session = { repo: null, github: { ...gh } };
    expect(githubCluster(session)?.noRepository).toBe(true);
    expect(looseRepoClause(session)).toBeNull();
  });

  it("says a shared repo once, on the GitHub chip", () => {
    const session = { repo: "acme/app", branch: "main", github: { ...gh, repo: "acme/app", branch: "main", credential: "default" as const } };
    expect(githubCluster(session)?.repo).toBe("acme/app @ main");
    expect(githubCluster(session)?.credential).toBe("shared token");
    expect(looseRepoClause(session)).toBeNull();
  });

  it("uses the floppy repo inside the chip when the broker has no repo of its own", () => {
    const session = { repo: "acme/app", branch: "wip", github: { ...gh, credential: "session" as const, onBehalfOf: "mgmonteleone" } };
    const cluster = githubCluster(session);
    expect(cluster?.repo).toBe("acme/app @ wip");
    expect(cluster?.noRepository).toBe(false);
    expect(cluster?.credential).toBe("session token");
    expect(cluster?.onBehalfOf).toBe("mgmonteleone");
    expect(cluster?.branchOnly).toBe(false);
    expect(looseRepoClause(session)).toBeNull();
  });

  it("keeps a checkout that differs from the broker target, because they are different facts", () => {
    const session = { repo: "acme/app", branch: "wip", github: { ...gh, repo: "acme/other", branch: "trunk", merge: true } };
    expect(githubCluster(session)?.repo).toBe("acme/other @ trunk");
    expect(githubCluster(session)?.mergeLabel).toBe("merge allowed");
    expect(githubCluster(session)?.branchOnly).toBe(true);
    expect(looseRepoClause(session)).toBe("acme/app @ wip");
  });

  it("keeps a checkout on the same repo when its branch differs from the broker", () => {
    const session = { repo: "acme/app", branch: "wip", github: { ...gh, repo: "acme/app", branch: "main" } };
    expect(githubCluster(session)?.repo).toBe("acme/app @ main");
    expect(looseRepoClause(session)).toBe("acme/app @ wip");
  });

  it("treats a branch present on only one side as a different checkout", () => {
    const brokerOnly = { repo: "acme/app", github: { ...gh, repo: "acme/app", branch: "main" } };
    expect(githubCluster(brokerOnly)?.repo).toBe("acme/app @ main");
    expect(looseRepoClause(brokerOnly)).toBe("acme/app");

    const checkoutOnly = { repo: "acme/app", branch: "wip", github: { ...gh, repo: "acme/app" } };
    expect(githubCluster(checkoutOnly)?.repo).toBe("acme/app");
    expect(looseRepoClause(checkoutOnly)).toBe("acme/app @ wip");
  });

  it("falls back to one no-repository clause when there is no GitHub block", () => {
    expect(githubCluster({ repo: null })).toBeNull();
    expect(looseRepoClause({ repo: null })).toBe("no repository");
    expect(looseRepoClause({ repo: "acme/app", branch: "main" })).toBe("acme/app @ main");
    expect(looseRepoClause(null)).toBeNull();
  });
});
