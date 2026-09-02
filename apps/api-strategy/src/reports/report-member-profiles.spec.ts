import { describe, expect, it } from "@jest/globals";
import { extractMemberRef } from "./report-policy.js";
import { collectMemberProfiles } from "./report-snapshot.service.js";
import type { ReportNode } from "./report.types.js";

describe("extractMemberRef", () => {
  it("reduces a stored targetRef to the report-safe reference", () => {
    expect(
      extractMemberRef({
        clientTargetId: "ct-1",
        memberId: "member-52480",
        memberName: " Maria Cantwell ",
        party: "D",
        state: "WA",
        chamber: "senate",
        committee: "Commerce",
        sourceDirectory: "congress",
      }),
    ).toEqual({
      memberId: "member-52480",
      memberName: "Maria Cantwell",
      party: "D",
      state: "WA",
      chamber: "senate",
      committee: "Commerce",
      sourceDirectory: "congress",
    });
  });

  it("returns null without a memberId and nulls unknown directories", () => {
    expect(extractMemberRef(null)).toBeNull();
    expect(extractMemberRef({ memberName: "Someone" })).toBeNull();
    expect(extractMemberRef({ memberId: "   " })).toBeNull();
    expect(
      extractMemberRef({ memberId: "m1", sourceDirectory: "lobbyists" })
        ?.sourceDirectory,
    ).toBeNull();
  });
});

describe("collectMemberProfiles", () => {
  it("groups included steps by member, in plan order, skipping staff targets", () => {
    const profiles = collectMemberProfiles([
      node({ id: "a", memberRef: ref("member-1", { memberName: null }) , targetLabel: "Office A"}),
      node({ id: "b", memberRef: ref("member-2", { memberName: "Rep. Two" }) }),
      node({ id: "c", memberRef: ref("member-1", { memberName: "Sen. One", party: "R" }) }),
      node({ id: "d", memberRef: ref("staff-9", { sourceDirectory: "staff" }) }),
      node({ id: "e", memberRef: null }),
    ]);
    expect(profiles.map((profile) => profile.memberId)).toEqual([
      "member-1",
      "member-2",
    ]);
    expect(profiles[0]).toMatchObject({
      name: "Sen. One",
      memberName: "Sen. One",
      party: "R",
      nodeIds: ["a", "c"],
    });
    expect(profiles[1]!.nodeIds).toEqual(["b"]);
  });
});

function ref(
  memberId: string,
  overrides: Partial<NonNullable<ReportNode["memberRef"]>> = {},
): NonNullable<ReportNode["memberRef"]> {
  return {
    memberId,
    memberName: "Member",
    party: null,
    state: null,
    chamber: null,
    committee: null,
    sourceDirectory: "congress",
    ...overrides,
  };
}

function node(overrides: Partial<ReportNode>): ReportNode {
  return {
    id: "node",
    kind: "action",
    subject: "member",
    title: "Plan step",
    note: null,
    ownerAssigned: true,
    ownerName: "Team member",
    status: "in_progress",
    startsOn: "2026-08-15",
    endsOn: "2026-09-15",
    openEnded: false,
    dependsOnIds: [],
    sources: [],
    targetLabel: null,
    memberRef: null,
    ...overrides,
  };
}
