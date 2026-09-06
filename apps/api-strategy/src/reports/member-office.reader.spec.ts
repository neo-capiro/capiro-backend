import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { ConfigService } from "@nestjs/config";
import {
  DirectoryMemberOfficeReader,
  fallbackDetail,
  isAllowedPhotoUrl,
  mapMemberDetail,
  pickWashingtonOffice,
} from "./member-office.reader.js";
import type { ReportMemberProfile } from "./report.types.js";

const member: ReportMemberProfile = {
  memberId: "member-52480",
  memberName: "Maria Cantwell",
  party: "D",
  state: "WA",
  chamber: "senate",
  committee: "Commerce",
  sourceDirectory: "congress",
  name: "Maria Cantwell",
  nodeIds: ["gate"],
};

const detailPayload = {
  kind: "member",
  id: "member-52480",
  identity: {
    memberId: 52480,
    bioguideId: "C000127",
    firstName: "Maria",
    lastName: "Cantwell",
    preferredFirstName: null,
    preferredLastName: null,
    suffix: null,
  },
  bioDetails: { partyName: "Democrat" },
  offices: [
    { officeId: 1, name: "Senator Maria Cantwell", officeTypeId: "sen", state: "WA", district: null, party: "D", status: "current" },
  ],
  officeAddresses: [
    { label: "Campaign Office", address1: "P.O. Box 12740", address2: "", city: "Seattle", state: "WA", zip: "98111", zipExt: null, phone: null, fax: null, isMain: false },
    { label: "Other Staff", address1: "511 Hart Senate Office Building", address2: "", city: "Washington", state: "DC", zip: "20510", zipExt: null, phone: "(202) 224-3441", fax: "(202) 228-0514", isMain: false },
    { label: "Spokane Office", address1: "U.S. Federal Courthouse", address2: "920 W. Riverside Ave., Suite 697", city: "Spokane", state: "WA", zip: "99201", zipExt: null, phone: null, fax: null, isMain: true },
  ],
  committees: [{ committeeId: "committee-1", position: "Chair" }],
  selectedPhotoUrl: "https://img.legistorm.com/people/480/52480.jpg?rand=1",
  photoSource: "legistorm",
};

describe("member office reader mapping", () => {
  it("maps Directory detail onto the report contract and picks the DC office", () => {
    const detail = mapMemberDetail(member, detailPayload, ["img.legistorm.com"]);
    expect(detail).toEqual({
      memberId: "member-52480",
      name: "Maria Cantwell",
      party: "Democrat",
      state: "WA",
      chamber: "Senate",
      district: null,
      committees: ["Commerce"],
      washingtonOffice: {
        label: "Other Staff",
        address1: "511 Hart Senate Office Building",
        address2: null,
        city: "Washington",
        state: "DC",
        zip: "20510",
        phone: "(202) 224-3441",
        fax: "(202) 228-0514",
      },
      photoUrl: "https://img.legistorm.com/people/480/52480.jpg?rand=1",
      photoSource: "legistorm",
      resolved: true,
    });
  });

  it("drops portraits from hosts outside the allow-list", () => {
    const detail = mapMemberDetail(
      member,
      { ...detailPayload, selectedPhotoUrl: "https://evil.example/photo.jpg" },
      ["img.legistorm.com"],
    );
    expect(detail.photoUrl).toBeNull();
  });

  it("falls back to the stored reference when the payload is unusable", () => {
    expect(mapMemberDetail(member, null, [])).toEqual(fallbackDetail(member));
    expect(fallbackDetail(member)).toMatchObject({
      name: "Maria Cantwell",
      party: "D",
      committees: ["Commerce"],
      washingtonOffice: null,
      photoUrl: null,
      resolved: false,
    });
  });

  it("prefers a Capitol-complex DC address, then the main office, then any DC row", () => {
    expect(
      pickWashingtonOffice([
        { label: null, address1: "1 Main St", address2: null, city: "Washington", state: "DC", zip: null, phone: null, fax: null, isMain: true },
        { label: null, address1: "2113 Rayburn House Office Building", address2: null, city: "Washington", state: "DC", zip: null, phone: null, fax: null, isMain: false },
      ])?.address1,
    ).toBe("2113 Rayburn House Office Building");
    expect(
      pickWashingtonOffice([
        { label: null, address1: "Home office", address2: null, city: "Spokane", state: "WA", zip: null, phone: null, fax: null, isMain: true },
      ]),
    ).toBeNull();
  });

  it("only allows https URLs on allow-listed hosts without credentials", () => {
    const hosts = ["img.legistorm.com"];
    expect(isAllowedPhotoUrl("https://img.legistorm.com/people/1.jpg", hosts)).toBe(true);
    expect(isAllowedPhotoUrl("https://cdn.img.legistorm.com/people/1.jpg", hosts)).toBe(true);
    expect(isAllowedPhotoUrl("http://img.legistorm.com/people/1.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("https://user:pw@img.legistorm.com/1.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("https://img.legistorm.com.evil.example/1.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("not a url", hosts)).toBe(false);
  });
});

describe("DirectoryMemberOfficeReader", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function reader() {
    const config = {
      get: jest.fn((key: string) =>
        key === "API_INTERNAL_URL" ? "https://api.internal.test" : undefined,
      ),
    } as unknown as ConfigService;
    return new DirectoryMemberOfficeReader(config);
  }

  it("resolves congressional members under the caller bearer and caches the result", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => detailPayload,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const instance = reader();

    const first = await instance.resolve({ bearer: "token-1", members: [member] });
    const second = await instance.resolve({ bearer: "token-1", members: [member] });

    expect(first[0]!.resolved).toBe(true);
    expect(second[0]!.washingtonOffice?.address1).toBe("511 Hart Senate Office Building");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.internal.test/api/directory/members/member-52480");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
  });

  it("fails soft to the stored reference when the Directory is unavailable or no bearer exists", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const instance = reader();

    const [detail] = await instance.resolve({ bearer: "token-1", members: [member] });
    expect(detail).toEqual(fallbackDetail(member));

    const [noBearer] = await instance.resolve({ bearer: undefined, members: [member] });
    expect(noBearer!.resolved).toBe(false);
  });

  it("does not share cached Directory authorization or reference fallbacks between callers", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).authorization;
      return {
        ok: token === "Bearer allowed", status: token === "Bearer allowed" ? 200 : 403,
        json: async () => detailPayload,
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const instance = reader();

    const [first] = await instance.resolve({ bearer: "denied", members: [member] });
    const [second] = await instance.resolve({ bearer: "allowed", members: [member] });
    const [third] = await instance.resolve({ bearer: "different-denied", members: [member] });
    const [differentReference] = await instance.resolve({
      bearer: "allowed", members: [{ ...member, committee: "Armed Services" }],
    });

    expect(first!.resolved).toBe(false);
    expect(second!.resolved).toBe(true);
    expect(third!.resolved).toBe(false);
    expect(differentReference!.committees).toEqual(["Armed Services"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([null, "12"])("stops oversized portrait streams even when Content-Length is %s", async (declared) => {
    const cancel = jest.fn(() => undefined);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (declared !== null) headers.set("content-length", declared);
    global.fetch = jest.fn(async () => new Response(stream, { headers })) as unknown as typeof fetch;

    await expect(reader().photo("https://img.legistorm.com/people/large.jpg")).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulled).toBe(3);
  });

  it("never fetches state legislators from the congressional directory", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const [detail] = await reader().resolve({
      bearer: "token-1",
      members: [{ ...member, sourceDirectory: "state" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(detail!.resolved).toBe(false);
  });

  it("refuses portraits that are not PNG/JPEG bytes from an allow-listed host", async () => {
    const fetchMock = jest.fn(async () => new Response(
      new Uint8Array([0x47, 0x49, 0x46, 0x38]),
      { headers: { "content-length": "4" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;
    const instance = reader();

    expect(await instance.photo("https://img.legistorm.com/people/1.gif")).toBeNull();
    expect(await instance.photo("https://evil.example/people/1.jpg")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });
});
