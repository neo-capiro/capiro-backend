#!/usr/bin/env python3
"""Extract Florida legislative directory PDFs into a deterministic enrichment manifest.

This is deliberately an offline, additive extractor. It does not connect to a database
or decide which values should overwrite an existing provider record. Downstream code
can use the source hashes and field-level provenance to fill only missing fields.

Dependencies: pdfplumber, pypdf, Pillow.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import pdfplumber
from PIL import Image
from pypdf import PdfReader


SCHEMA_VERSION = 1
PARSER_VERSION = "1.0.0"
HOUSE_SHA256 = "d22307e5f0809fc19fb3e3964232542b288a95d868e021f8813ccbee893a37cc"
SENATE_SHA256 = "f39f6880aef73025919a73eefbc12da6f1ba23b7d547766473f8a3d1a58c152d"
HOUSE_AS_OF_DATE = "2026-06-04"
SENATE_AS_OF_DATE = "2026-08-26"
HOUSE_COMMITTEE_PAGES = range(38, 75)
HOUSE_MEMBER_PAGES = range(78, 138)
HOUSE_PORTRAIT_PAGES = range(78, 137)
HOUSE_OFFICE_PAGES = range(7, 38)
SENATE_MEMBER_PAGES = range(4, 23)
SENATE_COMMITTEE_PAGES = range(23, 31)
SENATE_OFFICE_PAGES = (2, 3, 31, 32, 33)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_HOUSE_PDF = Path.home() / "Downloads" / "HouseDirectory.pdf"
DEFAULT_SENATE_PDF = Path.home() / "Downloads" / "SDIR.pdf"
DEFAULT_INVENTORY = (
    REPO_ROOT / "apps" / "api" / "data" / "florida-official-committee-inventory.json"
)
DEFAULT_MANIFEST = (
    REPO_ROOT
    / "apps"
    / "api"
    / "data"
    / "florida-legislative-directory"
    / "directory-enrichment.json"
)
DEFAULT_PORTRAIT_DIR = (
    REPO_ROOT / "apps" / "web" / "public" / "florida-directory" / "portraits"
)

PHONE_RE = re.compile(r"\(\d{3}\)\s*\d{3}-\d{4}")
EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
PARTY_RE = re.compile(r"\((R|D|NPA)\)")
HOUSE_FOOTER_RE = re.compile(
    r"^(?:\d+\s*\|\s*)?FLORIDA HOUSE OF REPRESENTATIVES DIRECTORY(?:\s*\|\s*\d+)?$",
    re.IGNORECASE,
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collapse_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", normalize_text(value).lower())


def repair_doubled_glyphs(value: str) -> str:
    """Repair InDesign text objects whose glyphs were emitted twice.

    The affected strings consist of pairwise-duplicated non-space glyphs, for
    example ``IInnffoorrmmaattiioonn``. Ordinary words are returned unchanged.
    """

    repaired: list[str] = []
    for token in re.split(r"(\s+)", value):
        if not token or token.isspace():
            repaired.append(token)
            continue
        if (
            len(token) % 2 == 0
            and any(character.isalpha() for character in token)
            and all(
                token[index] == token[index + 1]
                for index in range(0, len(token), 2)
            )
        ):
            repaired.append(token[::2])
        else:
            repaired.append(token)
    return "".join(repaired)


def normalize_text(value: str) -> str:
    value = repair_doubled_glyphs(value)
    replacements = {
        "Fabi\ufffdn": "Fabián",
        "L\ufffdpez": "López",
        "Vald\ufffds": "Valdés",
        "House\ufffds": "House's",
        "Governor\ufffds": "Governor's",
        "Children\ufffds": "Children's",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    value = re.sub(r"\ufffd([^\ufffd\n]{1,48})\ufffd", r'"\1"', value)
    return value.replace("\ufffd", "'").replace("\u2022", "•")


def dehyphenate_wrapped(value: str) -> str:
    return re.sub(r"([A-Za-z])-[ \t]*\n[ \t]*([a-z])", r"\1\2", value)


def clean_lines(value: str) -> list[str]:
    return [normalize_text(line).strip() for line in value.splitlines() if line.strip()]


def text_provenance(
    *,
    source_id: str,
    source_sha256: str,
    page_number: int,
    page_object_id: int | None,
    source_text: str,
    crop_bbox: Sequence[float] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "sourceId": source_id,
        "sourceSha256": source_sha256,
        "pageNumber": page_number,
        "pageObjectId": page_object_id,
        "textSha256": sha256_bytes(source_text.encode("utf-8")),
    }
    if crop_bbox is not None:
        result["cropBboxPoints"] = [round(value, 3) for value in crop_bbox]
    return result


def pdf_metadata(reader: PdfReader) -> dict[str, Any]:
    metadata = reader.metadata or {}
    selected = {
        key.lstrip("/"): str(metadata[key])
        for key in ("/Title", "/Author", "/Creator", "/Producer", "/CreationDate", "/ModDate")
        if metadata.get(key) is not None
    }
    return selected


def page_object_id(reader: PdfReader, page_number: int) -> int | None:
    reference = reader.pages[page_number - 1].indirect_reference
    return reference.idnum if reference is not None else None


def page_text(page: Any) -> str:
    return page.extract_text(x_tolerance=2, y_tolerance=3) or ""


def parse_party_name(value: str) -> tuple[str, str | None]:
    match = re.search(r"^(.*)\s+\((R|D|NPA)\)$", collapse_space(value))
    if not match:
        return collapse_space(value), None
    return match.group(1).strip(), match.group(2)


def normalize_party_token(value: str) -> str:
    """Repair PDF text runs that split the nonpartisan marker across fonts."""

    return re.sub(r"\(\s*N\s*PA\s*\)", "(NPA)", value, flags=re.IGNORECASE)


def split_roster_names(value: str) -> list[str]:
    value = dehyphenate_wrapped(value)
    value = re.sub(r"\b(?:Representatives|Senators)\b\s*:?") if False else value
    value = re.sub(r"^(?:Representatives|Senators)\s*:?[ ]*", "", value, flags=re.I)
    value = re.sub(r"\s+and\s+", ", ", collapse_space(value), flags=re.I)
    return [item.strip(" ,.;") for item in value.split(",") if item.strip(" ,.;")]


def group_words_into_lines(words: Iterable[dict[str, Any]], tolerance: float = 1.2) -> list[list[dict[str, Any]]]:
    lines: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (float(item["top"]), float(item["x0"]))):
        if not lines or abs(float(word["top"]) - float(lines[-1][0]["top"])) > tolerance:
            lines.append([word])
        else:
            lines[-1].append(word)
    for line in lines:
        line.sort(key=lambda item: float(item["x0"]))
    return lines


def line_text(words: Sequence[dict[str, Any]]) -> str:
    return " ".join(str(word["text"]) for word in words)


def positioned_text(words: Iterable[dict[str, Any]]) -> str:
    return "\n".join(line_text(line) for line in group_words_into_lines(words))


def parse_house_members(
    plumber_pdf: Any,
    reader: PdfReader,
    source_sha256: str,
) -> tuple[list[dict[str, Any]], dict[str, bytes], list[dict[str, Any]]]:
    members: list[dict[str, Any]] = []
    portraits: dict[str, bytes] = {}
    ambiguities: list[dict[str, Any]] = []

    for page_number in HOUSE_MEMBER_PAGES:
        page = plumber_pdf.pages[page_number - 1]
        pypdf_page = reader.pages[page_number - 1]
        page_images = {image.name: image for image in pypdf_page.images}
        layout_images = sorted(page.images, key=lambda item: float(item["x0"]))

        if page_number in HOUSE_PORTRAIT_PAGES and len(layout_images) != 2:
            raise ValueError(
                f"House member page {page_number} must contain two portrait images; "
                f"found {len(layout_images)}"
            )
        if page_number == 137 and layout_images:
            raise ValueError("Pending-election House page 137 unexpectedly contains portraits")

        for side, bbox in (("left", (35.0, 25.0, 300.0, 765.0)), ("right", (330.0, 25.0, 577.0, 765.0))):
            cropped = page.crop(bbox)
            raw_text = page_text(cropped)
            lines = clean_lines(raw_text)
            lines = [line for line in lines if line != "MEMBERS" and not HOUSE_FOOTER_RE.match(line)]
            district_index = next(
                (index for index, line in enumerate(lines) if re.match(r"^DISTRICT\s+\d+", line)),
                None,
            )
            if district_index is None:
                raise ValueError(f"House member profile has no district on page {page_number} ({side})")

            name = collapse_space(" ".join(lines[:district_index]))
            district_match = re.match(r"^DISTRICT\s+(\d+)(?:\s+\((R|D|NPA)\))?", lines[district_index])
            if not district_match:
                raise ValueError(f"Unparseable House district on page {page_number} ({side})")
            district = int(district_match.group(1))
            party = district_match.group(2)
            vacant = name.lower() == "pending election"

            committee_index = next(
                (index for index, line in enumerate(lines) if line == "Committee Membership"),
                None,
            )
            contact_index = next(
                (index for index, line in enumerate(lines) if line == "Contact Information"),
                None,
            )
            staff_index = next(
                (index for index, line in enumerate(lines) if line == "Legislative Staff"),
                None,
            )

            leadership_titles: list[str] = []
            if committee_index is not None:
                leadership_titles = [
                    collapse_space(line)
                    for line in lines[district_index + 1 : committee_index]
                    if line and line not in {"Committee Membership"}
                ]

            committee_memberships: list[dict[str, Any]] = []
            if committee_index is not None and contact_index is not None:
                current: list[str] = []
                for line in lines[committee_index + 1 : contact_index]:
                    if line.startswith(("•", "'")):
                        if current:
                            committee_memberships.append(parse_house_membership(" ".join(current)))
                        current = [line[1:].strip()]
                    elif current:
                        current.append(line)
                if current:
                    committee_memberships.append(parse_house_membership(" ".join(current)))

            email = next(iter(EMAIL_RE.findall(raw_text)), None)
            contact_lines = lines[contact_index + 1 : staff_index] if contact_index is not None else []
            capitol_raw = section_between(contact_lines, "CAPITOL OFFICE", ("DISTRICT OFFICE", "DISTRICT OFFICES"))
            district_raw = section_after_any(contact_lines, ("DISTRICT OFFICE", "DISTRICT OFFICES"))
            staff = parse_house_member_staff(page, bbox, raw_text)

            record: dict[str, Any] = {
                "chamber": "house",
                "district": district,
                "party": party,
                "name": name,
                "vacant": vacant,
                "leadershipTitles": leadership_titles,
                "committeeMemberships": committee_memberships,
                "contact": {
                    "email": email,
                    "capitolOfficeRaw": "\n".join(capitol_raw) or None,
                    "capitolPhones": PHONE_RE.findall("\n".join(capitol_raw)),
                    "districtOfficesRaw": "\n".join(district_raw) or None,
                    "districtPhones": PHONE_RE.findall("\n".join(district_raw)),
                },
                "legislativeStaff": staff,
                "sourceText": raw_text,
                "provenance": text_provenance(
                    source_id="houseDirectory",
                    source_sha256=source_sha256,
                    page_number=page_number,
                    page_object_id=page_object_id(reader, page_number),
                    source_text=raw_text,
                    crop_bbox=bbox,
                ),
            }

            if not vacant:
                image_index = 0 if side == "left" else 1
                layout_image = layout_images[image_index]
                image_name = str(layout_image.get("name"))
                image_file = page_images.get(f"{image_name}.jpg") or page_images.get(image_name)
                if image_file is None:
                    candidates = sorted(page_images.values(), key=lambda item: item.name)
                    if image_index >= len(candidates):
                        raise ValueError(
                            f"Could not map portrait {image_name!r} on House page {page_number}"
                        )
                    image_file = candidates[image_index]
                    ambiguities.append(
                        {
                            "kind": "portrait-image-name-fallback",
                            "pageNumber": page_number,
                            "side": side,
                            "requestedImageName": image_name,
                            "selectedImageName": image_file.name,
                        }
                    )
                image_bytes = image_file.data
                with Image.open(io.BytesIO(image_bytes)) as image:
                    width, height = image.size
                    media_type = Image.MIME.get(image.format, "image/jpeg")
                slug = slugify(name)
                filename = f"house-district-{district:03d}-{slug}.jpg"
                if filename in portraits:
                    raise ValueError(f"Duplicate portrait filename {filename}")
                portraits[filename] = image_bytes
                stream = layout_image.get("stream")
                image_object_id = getattr(stream, "objid", None)
                record["portrait"] = {
                    "publicUrl": f"/florida-directory/portraits/{filename}",
                    "filename": filename,
                    "mediaType": media_type,
                    "sha256": sha256_bytes(image_bytes),
                    "byteLength": len(image_bytes),
                    "width": width,
                    "height": height,
                    "source": {
                        "sourceId": "houseDirectory",
                        "sourceSha256": source_sha256,
                        "pageNumber": page_number,
                        "pageObjectId": page_object_id(reader, page_number),
                        "imageObjectId": image_object_id,
                        "imageName": image_name,
                        "bboxPoints": [
                            round(float(layout_image[key]), 3)
                            for key in ("x0", "top", "x1", "bottom")
                        ],
                        "sourcePixelSize": list(layout_image.get("srcsize") or (width, height)),
                        "imageSha256": sha256_bytes(image_bytes),
                    },
                }
            members.append(record)

    members.sort(key=lambda item: item["district"])
    if len(members) != 120:
        raise ValueError(f"Expected 120 House district profiles, found {len(members)}")
    if len(portraits) != 118:
        raise ValueError(f"Expected 118 House portraits, found {len(portraits)}")
    if sum(1 for member in members if member["vacant"]) != 2:
        raise ValueError("Expected exactly two pending-election House profiles")
    return members, portraits, ambiguities


def parse_house_membership(value: str) -> dict[str, Any]:
    value = collapse_space(normalize_text(value)).strip("• ")
    role_match = re.search(r"\s+\((Chair|Vice Chair|Democratic Ranking Member)\)\s*$", value, re.I)
    role = role_match.group(1) if role_match else None
    name = value[: role_match.start()].strip() if role_match else value
    return {"committeeName": name, "role": role}


def section_between(lines: Sequence[str], start: str, ends: Sequence[str]) -> list[str]:
    try:
        start_index = lines.index(start) + 1
    except ValueError:
        return []
    end_index = len(lines)
    for index in range(start_index, len(lines)):
        if any(lines[index].startswith(end) for end in ends):
            end_index = index
            break
    return list(lines[start_index:end_index])


def section_after_any(lines: Sequence[str], starts: Sequence[str]) -> list[str]:
    for index, line in enumerate(lines):
        if any(line.startswith(start) for start in starts):
            return list(lines[index + 1 :])
    return []


def parse_house_member_staff(
    page: Any, bbox: Sequence[float], raw_text: str
) -> list[dict[str, Any]]:
    words = page.crop(tuple(bbox)).extract_words(extra_attrs=["size", "fontname"])
    headings = [word for word in words if word["text"] == "Legislative" and float(word["size"]) >= 12]
    if not headings:
        return []
    heading_top = max(float(word["top"]) for word in headings)
    relevant = [
        word
        for word in words
        if float(word["top"]) > heading_top + 8
        and float(word["top"]) < 756
        and not HOUSE_FOOTER_RE.search(str(word["text"]))
    ]
    midpoint = float(bbox[0]) + 118.0
    result: list[dict[str, Any]] = []
    for side_words in (
        [word for word in relevant if float(word["x0"]) < midpoint],
        [word for word in relevant if float(word["x0"]) >= midpoint],
    ):
        role_words = [word for word in side_words if 7.0 <= float(word["size"]) <= 8.5]
        name_words = [word for word in side_words if 9.5 <= float(word["size"]) <= 11.5]
        if not role_words or not name_words:
            continue
        role_top = min(float(word["top"]) for word in role_words)
        role = line_text([word for word in role_words if abs(float(word["top"]) - role_top) <= 1.2])
        name_lines = [
            line_text(line)
            for line in group_words_into_lines(name_words)
            if float(line[0]["top"]) > role_top
        ]
        names = [collapse_space(name) for name in name_lines if name and "DIRECTORY" not in name]
        if role and names:
            result.append({"role": collapse_space(role).title(), "names": names})
    return result


def slugify(value: str) -> str:
    value = normalize_text(value).lower()
    value = (
        value.replace("á", "a")
        .replace("é", "e")
        .replace("í", "i")
        .replace("ó", "o")
        .replace("ú", "u")
        .replace("ñ", "n")
    )
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or "member"


def parse_house_committees(
    plumber_pdf: Any,
    reader: PdfReader,
    source_sha256: str,
    inventory_rows: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    allowed = [row for row in inventory_rows if row["chamber"] in {"house", "joint"}]
    by_name = {normalized_key(row["name"]): row for row in allowed}
    records: dict[str, dict[str, Any]] = {}
    ambiguities: list[dict[str, Any]] = []

    for page_number in range(38, 73):
        page = plumber_pdf.pages[page_number - 1]
        raw_text = page_text(page)
        lines = clean_lines(raw_text)
        if len(lines) < 2:
            raise ValueError(f"House committee page {page_number} has no title")
        visible_title = repair_doubled_glyphs(lines[1])
        inventory = by_name.get(normalized_key(visible_title))
        if inventory is None:
            raise ValueError(
                f"House committee page {page_number} title {visible_title!r} "
                "does not match the official inventory"
            )
        parsed = parse_house_committee_page(page, page_number, inventory)
        parsed_source = {
            "bodyGroup": normalize_text(lines[0]),
            "sourceText": raw_text,
            "provenance": text_provenance(
                source_id="houseDirectory",
                source_sha256=source_sha256,
                page_number=page_number,
                page_object_id=page_object_id(reader, page_number),
                source_text=raw_text,
            ),
        }
        code = inventory["officialCode"]
        if code not in records:
            records[code] = committee_inventory_base(inventory)
            records[code].update(parsed)
            records[code]["sources"] = [parsed_source]
        else:
            records[code]["sources"].append(parsed_source)
            records[code]["bodyGroups"] = sorted(
                set(records[code].get("bodyGroups", []))
                | {source["bodyGroup"] for source in records[code]["sources"]}
            )
            merge_unique(records[code], parsed, "roster", lambda item: (item["name"], item["party"]))
            merge_unique(records[code], parsed, "leadership", lambda item: (item["name"], item["role"]))
            merge_unique(records[code], parsed, "staff", lambda item: (item["name"], item["role"]))
            if len(parsed.get("description") or "") > len(records[code].get("description") or ""):
                records[code]["description"] = parsed.get("description")
            ambiguities.append(
                {
                    "kind": "committee-presented-under-two-house-parent-groups",
                    "officialCode": code,
                    "name": inventory["name"],
                    "pageNumbers": sorted(
                        source["provenance"]["pageNumber"] for source in records[code]["sources"]
                    ),
                    "resolution": "merged-without-discarding-either-source-page",
                }
            )

    for page_number in (73, 74):
        page = plumber_pdf.pages[page_number - 1]
        raw_text = page_text(page)
        lines = clean_lines(raw_text)
        matches = find_inventory_sections(lines, [row for row in allowed if row["chamber"] == "joint"])
        for match_index, (line_index, span, inventory) in enumerate(matches):
            end_index = matches[match_index + 1][0] if match_index + 1 < len(matches) else len(lines)
            section_lines = lines[line_index : end_index]
            section_text = "\n".join(section_lines)
            parsed = parse_house_joint_section(section_lines)
            record = committee_inventory_base(inventory)
            record.update(parsed)
            record["sources"] = [
                {
                    "bodyGroup": "JOINT COMMISSION & COMMITTEES",
                    "sourceText": section_text,
                    "provenance": text_provenance(
                        source_id="houseDirectory",
                        source_sha256=source_sha256,
                        page_number=page_number,
                        page_object_id=page_object_id(reader, page_number),
                        source_text=section_text,
                    ),
                }
            ]
            records[inventory["officialCode"]] = record

    ordered = sorted(records.values(), key=lambda item: (item["chamber"], item["name"]))
    expected_codes = {row["officialCode"] for row in allowed}
    if set(records) != expected_codes:
        raise ValueError(
            "House directory committee coverage mismatch: "
            f"missing={sorted(expected_codes - set(records))}, "
            f"extra={sorted(set(records) - expected_codes)}"
        )
    return ordered, ambiguities


def committee_inventory_base(inventory: dict[str, Any]) -> dict[str, Any]:
    return {
        "chamber": inventory["chamber"],
        "officialCode": inventory["officialCode"],
        "name": inventory["name"],
        "officialUrl": inventory["officialUrl"],
        "inventoryExisting": inventory.get("existing", []),
        "inventoryMissing": bool(inventory.get("missing")),
    }


def merge_unique(
    target: dict[str, Any],
    incoming: dict[str, Any],
    field: str,
    key: Any,
) -> None:
    merged = {key(item): item for item in target.get(field, [])}
    for item in incoming.get(field, []):
        merged.setdefault(key(item), item)
    target[field] = list(merged.values())


def parse_house_committee_page(page: Any, page_number: int, inventory: dict[str, Any]) -> dict[str, Any]:
    raw_text = page_text(page)
    lines = clean_lines(raw_text)
    contact_line = lines[2] if len(lines) > 2 else ""
    roster = parse_house_roster(raw_text)
    leadership = parse_house_committee_leadership(page)
    staff = parse_house_committee_staff(page)
    description = parse_house_committee_description(raw_text)
    return {
        "bodyGroups": [normalize_text(lines[0])] if lines else [],
        "contactLine": contact_line or None,
        "phones": PHONE_RE.findall(contact_line),
        "roster": roster,
        "leadership": leadership,
        "staff": staff,
        "description": description,
    }


def parse_house_roster(raw_text: str) -> list[dict[str, Any]]:
    start = raw_text.find("REPRESENTATIVES:")
    if start < 0:
        return []
    tail = raw_text[start + len("REPRESENTATIVES:") :]
    narrative_positions = [
        position
        for marker in ("\nThe ", "\nBudget subcommittees", "\nCommittee Staff")
        if (position := tail.find(marker)) >= 0
    ]
    if narrative_positions:
        tail = tail[: min(narrative_positions)]
    matches = re.finditer(
        r"([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ.' -]*(?:,\s*[A-Z]\.)?)\s*\((R|D|NPA)\)",
        normalize_text(tail),
    )
    result: list[dict[str, Any]] = []
    for match in matches:
        name = collapse_space(match.group(1)).strip(" ,")
        name = re.sub(r"^(?:Committee\s+Staff\s+)+", "", name)
        if name and not name.startswith("Rep."):
            result.append({"name": name, "party": match.group(2)})
    return result


def parse_house_committee_leadership(page: Any) -> list[dict[str, Any]]:
    raw = page_text(page.crop((35.0, 100.0, 180.0, 760.0)))
    lines = clean_lines(raw)
    result: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        match = re.match(r"^Rep\.\s+(.+?)\s+\((R|D|NPA)\)", line)
        if not match:
            continue
        role_lines: list[str] = []
        for following in lines[index + 1 :]:
            if following.startswith("Rep."):
                break
            if following.isupper() or repair_doubled_glyphs(following).isupper():
                role_lines.append(repair_doubled_glyphs(following))
            elif role_lines:
                break
        if role_lines:
            result.append(
                {
                    "name": normalize_text(match.group(1)),
                    "party": match.group(2),
                    "role": collapse_space(" ".join(role_lines)).title(),
                }
            )
    return result


def parse_house_committee_staff(page: Any) -> list[dict[str, Any]]:
    words = page.extract_words(extra_attrs=["size", "fontname"])
    staff_headings = [
        word
        for word in words
        if str(word["text"]) == "Staff" and 14 <= float(word["size"]) <= 16
    ]
    if not staff_headings:
        return []
    heading_top = min(float(word["top"]) for word in staff_headings)
    name_words = [
        word
        for word in words
        if float(word["top"]) > heading_top + 8
        and float(word["x0"]) > 190
        and 10.75 <= float(word["size"]) <= 11.25
        and "Gibson-Regular" in str(word["fontname"])
    ]
    name_lines = group_words_into_lines(name_words)
    result: list[dict[str, Any]] = []
    for line in name_lines:
        top = float(line[0]["top"])
        cells: list[list[dict[str, Any]]] = []
        for word in line:
            if not cells or float(word["x0"]) - float(cells[-1][-1]["x1"]) > 22:
                cells.append([word])
            else:
                cells[-1].append(word)
        for cell_index, cell in enumerate(cells):
            name = normalize_text(line_text(cell))
            left = float(cell[0]["x0"]) - 3
            if cell_index + 1 < len(cells):
                right = (float(cell[-1]["x1"]) + float(cells[cell_index + 1][0]["x0"])) / 2
            else:
                right = 580.0
            role_words = [
                word
                for word in words
                if left <= float(word["x0"]) < right
                and top + 7 <= float(word["top"]) <= top + 35
                and 6.5 <= float(word["size"]) <= 8.5
            ]
            role = collapse_space(" ".join(line_text(group) for group in group_words_into_lines(role_words)))
            if name and role:
                result.append({"name": name, "role": role.title()})
    return result


def parse_house_committee_description(raw_text: str) -> str | None:
    roster = raw_text.find("REPRESENTATIVES:")
    if roster < 0:
        return None
    candidates = [
        position
        for marker in ("\nThe ", "\nBudget subcommittees")
        if (position := raw_text.find(marker, roster)) >= 0
    ]
    if not candidates:
        return None
    start = min(candidates) + 1
    end_candidates = [
        position
        for marker in ("\nCommittee Staff", "\nRep.", "\nNOTE:")
        if (position := raw_text.find(marker, start + 1)) >= 0
    ]
    end = min(end_candidates) if end_candidates else len(raw_text)
    return collapse_space(normalize_text(raw_text[start:end])) or None


def find_inventory_sections(
    lines: Sequence[str], inventory_rows: Sequence[dict[str, Any]]
) -> list[tuple[int, int, dict[str, Any]]]:
    by_name = {normalized_key(row["name"]): row for row in inventory_rows}
    matches: list[tuple[int, int, dict[str, Any]]] = []
    occupied: set[int] = set()
    for index in range(len(lines)):
        if index in occupied:
            continue
        for span in (1, 2, 3):
            if index + span > len(lines):
                continue
            candidate = " ".join(lines[index : index + span])
            candidate = PHONE_RE.sub("", candidate)
            inventory = by_name.get(normalized_key(candidate))
            if inventory is not None:
                matches.append((index, span, inventory))
                occupied.update(range(index, index + span))
                break
    matches.sort(key=lambda item: item[0])
    return matches


def parse_house_joint_section(lines: Sequence[str]) -> dict[str, Any]:
    text = "\n".join(lines)
    contact_line = lines[1] if len(lines) > 1 else ""
    representatives_match = re.search(
        r"REPRESENTATIVES:\s*(.*?)\s*Committee Staff:", text, re.S | re.I
    )
    roster: list[dict[str, Any]] = []
    if representatives_match:
        roster = [
            {"name": collapse_space(match.group(1)), "party": match.group(2)}
            for match in re.finditer(
                r"([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ.' -]*(?:,\s*[A-Z]\.)?)\s*\((R|D|NPA)\)",
                normalize_text(representatives_match.group(1)),
            )
        ]
    chair_match = re.search(r"Rep\.\s+(.+?)\s+\((R|D|NPA)\).*?ALTERNATING CHAIR", text, re.S)
    staff_match = re.search(r"Committee Staff:\s*(.*?)\s*Rep\.", text, re.S | re.I)
    staff_text = collapse_space(staff_match.group(1)) if staff_match else None
    return {
        "contactLine": contact_line or None,
        "phones": PHONE_RE.findall(contact_line),
        "roster": roster,
        "leadership": (
            [
                {
                    "name": normalize_text(chair_match.group(1)),
                    "party": chair_match.group(2),
                    "role": "Alternating Chair",
                }
            ]
            if chair_match
            else []
        ),
        "staff": parse_named_roles(staff_text or ""),
        "staffText": staff_text,
        "description": None,
        "bodyGroups": ["JOINT COMMISSION & COMMITTEES"],
    }


def parse_named_roles(value: str) -> list[dict[str, str]]:
    value = re.sub(r",?\s+and\s+", ", ", value)
    chunks = [chunk.strip(" ,") for chunk in value.split(",") if chunk.strip(" ,")]
    result: list[dict[str, str]] = []
    for index in range(0, len(chunks) - 1, 2):
        result.append({"name": chunks[index], "role": chunks[index + 1]})
    return result


def parse_senate_members(
    plumber_pdf: Any,
    reader: PdfReader,
    source_sha256: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    members: list[dict[str, Any]] = []
    ambiguities: list[dict[str, Any]] = []
    for page_number in SENATE_MEMBER_PAGES:
        page = plumber_pdf.pages[page_number - 1]
        words = page.extract_words(extra_attrs=["size", "fontname"])
        starts: list[tuple[float, str]] = []
        for line in group_words_into_lines(words):
            if not line or abs(float(line[0]["x0"]) - 42.0) > 2.5:
                continue
            text = normalize_party_token(
                line_text([word for word in line if float(word["x0"]) < 225])
            )
            bold = any("Bold" in str(word["fontname"]) for word in line)
            if bold and (text == "VACANT" or re.search(r"\((R|D|NPA)\)", text)):
                starts.append((float(line[0]["top"]), text))
        starts.sort()
        for index, (top, header) in enumerate(starts):
            bottom = starts[index + 1][0] - 1 if index + 1 < len(starts) else 760.0
            row_bbox = (36.0, max(0.0, top - 2), 580.0, bottom)
            row = page.crop(row_bbox)
            raw_text = page_text(row)
            row_words = [
                word for word in words if top - 2 <= float(word["top"]) < bottom
            ]
            committee_tops = [
                float(word["top"]) for word in row_words if str(word["text"]) == "Committees:"
            ]
            office_bottom = min(committee_tops) if committee_tops else bottom
            office_words = [
                word for word in row_words if float(word["top"]) < office_bottom
            ]
            # Select complete words by their anchored x coordinate instead of
            # cropping glyph streams. pdfplumber crops words that cross a
            # boundary, which previously leaked one-character fragments from
            # adjacent columns and the first committee line into addresses.
            left_text = positioned_text(
                word for word in office_words if float(word["x0"]) < 225.0
            )
            district_text = positioned_text(
                word
                for word in office_words
                if 225.0 <= float(word["x0"]) < 425.0
            )
            capitol_text = positioned_text(
                word for word in office_words if float(word["x0"]) >= 425.0
            )

            header_match = re.match(r"^([A-Z][A-Z .'-]*),\s*(.*?)\s+\((R|D|NPA)\)", header)
            vacant = header == "VACANT"
            if vacant:
                directory_name = "VACANT"
                last_name = None
                given_names = None
                party = None
            elif header_match:
                last_name = collapse_space(header_match.group(1))
                given_names = collapse_space(header_match.group(2))
                directory_name = f"{last_name}, {given_names}"
                party = header_match.group(3)
            else:
                raise ValueError(f"Unparseable Senate member header on page {page_number}: {header!r}")

            district_match = re.search(r"(\d+)(?:st|nd|rd|th) District", left_text, re.I)
            if not district_match:
                raise ValueError(f"Senate profile has no district on page {page_number}: {header!r}")
            district = int(district_match.group(1))
            spouse_match = re.search(r"Spouse:\s*(.+)", left_text)
            district_aide_text = parse_label_with_continuations(
                district_text, "Legislative Aide:"
            )
            capitol_aide_text = parse_label_with_continuations(
                capitol_text, "Legislative Aide:"
            )
            aide_texts = [
                value for value in (district_aide_text, capitol_aide_text) if value
            ]
            committees = parse_senate_member_committees(raw_text)
            leadership = parse_senate_member_leadership(left_text)
            members.append(
                {
                    "chamber": "senate",
                    "district": district,
                    "party": party,
                    "directoryName": directory_name,
                    "lastName": last_name,
                    "givenNames": given_names,
                    "vacant": vacant,
                    "leadershipTitles": leadership,
                    "spouse": collapse_space(spouse_match.group(1)) if spouse_match else None,
                    "committeeMemberships": committees,
                    "contact": {
                        "email": next(iter(EMAIL_RE.findall(district_text)), None),
                        "districtOfficeRaw": district_text,
                        "districtPhones": PHONE_RE.findall(district_text),
                        "districtVoip": re.findall(r"Senate VOIP\s+(\d+)", district_text, re.I),
                        "capitolOfficeRaw": capitol_text,
                        "capitolPhones": PHONE_RE.findall(capitol_text),
                        "capitolVoip": re.findall(r"Senate VOIP\s+(\d+)", capitol_text, re.I),
                    },
                    "legislativeAides": list(
                        dict.fromkeys(
                            name
                            for aide_text in aide_texts
                            for name in split_person_names(aide_text)
                        )
                    ),
                    "legislativeAidesRaw": aide_texts,
                    "sourceText": raw_text,
                    "provenance": text_provenance(
                        source_id="senateDirectory",
                        source_sha256=source_sha256,
                        page_number=page_number,
                        page_object_id=page_object_id(reader, page_number),
                        source_text=raw_text,
                        crop_bbox=row_bbox,
                    ),
                }
            )

    members.sort(key=lambda item: item["district"])
    if len(members) != 40:
        raise ValueError(f"Expected 40 Senate district profiles, found {len(members)}")
    if {member["district"] for member in members} != set(range(1, 41)):
        missing = sorted(set(range(1, 41)) - {member["district"] for member in members})
        duplicates = sorted(
            district
            for district, count in counts(member["district"] for member in members).items()
            if count > 1
        )
        raise ValueError(f"Senate district coverage invalid: missing={missing}, duplicates={duplicates}")
    return members, ambiguities


def counts(values: Iterable[Any]) -> dict[Any, int]:
    result: dict[Any, int] = defaultdict(int)
    for value in values:
        result[value] += 1
    return result


def parse_label_with_continuations(value: str, label: str) -> str | None:
    lines = clean_lines(value)
    for index, line in enumerate(lines):
        if not line.startswith(label):
            continue
        collected = [line[len(label) :].strip()]
        for continuation_index, following in enumerate(lines[index + 1 :]):
            # The widest Senate profiles use four printed aide lines. Limiting
            # continuation depth prevents the next multi-column committee row
            # from being mistaken for an aide when its left edge is clipped.
            if continuation_index >= 3:
                break
            if PHONE_RE.search(following) or EMAIL_RE.search(following):
                break
            if ";" in following or re.search(
                r"\b(?:on|committee|chair)\b", following, re.IGNORECASE
            ):
                break
            if re.search(r"\b(?:Street|Avenue|Road|Boulevard|Suite|Building|Capitol)\b", following, re.I):
                break
            if re.match(r"^\d", following):
                break
            collected.append(following)
        return collapse_space(" ".join(collected)) or None
    return None


def split_person_names(value: str | None) -> list[str]:
    if not value:
        return []
    normalized = re.sub(r"\s+and\s+", ", ", value, flags=re.I)
    return [item.strip() for item in normalized.split(",") if item.strip()]


def parse_office_directory_pages(
    plumber_pdf: Any,
    reader: PdfReader,
    source_id: str,
    source_sha256: str,
    page_numbers: Iterable[int],
) -> list[dict[str, Any]]:
    """Preserve non-committee office/staff listings without inventing identities.

    These pages contain valuable leadership, professional-staff, support-office,
    and contact facts, but no stable person or office identifiers. The reviewed
    artifact therefore keeps layout-normalized lines plus exact provenance; it
    deliberately does not project them into canonical database rows.
    """

    records: list[dict[str, Any]] = []
    for page_number in page_numbers:
        raw_text = page_text(plumber_pdf.pages[page_number - 1])
        lines = clean_lines(raw_text)
        records.append(
            {
                "pageNumber": page_number,
                "lines": lines,
                "phones": PHONE_RE.findall(raw_text),
                "emails": EMAIL_RE.findall(raw_text),
                "provenance": text_provenance(
                    source_id=source_id,
                    source_sha256=source_sha256,
                    page_number=page_number,
                    page_object_id=page_object_id(reader, page_number),
                    source_text=raw_text,
                ),
            }
        )
    return records


def parse_senate_member_committees(raw_text: str) -> list[dict[str, Any]]:
    match = re.search(r"Committees:\s*(.*)$", dehyphenate_wrapped(raw_text), re.S | re.I)
    if not match:
        return []
    value = collapse_space(match.group(1))
    value = re.sub(r";\s+and\s+", "; ", value)
    result: list[dict[str, Any]] = []
    for item in [chunk.strip(" .;") for chunk in value.split(";") if chunk.strip(" .;")]:
        role_match = re.search(r",\s*(Vice Chair|Chair)\s*$", item, re.I)
        result.append(
            {
                "committeeName": item[: role_match.start()].strip() if role_match else item,
                "role": role_match.group(1) if role_match else None,
            }
        )
    return result


def parse_senate_member_leadership(left_text: str) -> list[str]:
    lines = clean_lines(left_text)
    return [
        line
        for line in lines[1:]
        if line in {"President", "President Pro Tempore", "Majority Leader", "Minority Leader"}
    ]


def parse_senate_committees(
    plumber_pdf: Any,
    reader: PdfReader,
    source_sha256: str,
    inventory_rows: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]]]:
    allowed = [row for row in inventory_rows if row["chamber"] in {"senate", "joint"}]
    records: dict[tuple[str, str], dict[str, Any]] = {}
    meeting_rooms: list[dict[str, str]] = []
    ambiguities: list[dict[str, Any]] = []

    for page_number in SENATE_COMMITTEE_PAGES:
        page = plumber_pdf.pages[page_number - 1]
        raw_text = page_text(page)
        lines = clean_lines(raw_text)
        matches = find_inventory_sections(lines, allowed)
        for match_index, (line_index, span, inventory) in enumerate(matches):
            end_index = matches[match_index + 1][0] if match_index + 1 < len(matches) else len(lines)
            for marker in ("LOCATION OF SENATE MEETING ROOMS",):
                if marker in lines[line_index:end_index]:
                    end_index = lines.index(marker, line_index, end_index)
            section_lines = lines[line_index:end_index]
            section_text = "\n".join(section_lines)
            record = committee_inventory_base(inventory)
            record.update(parse_senate_committee_section(section_lines))
            record["sources"] = [
                {
                    "sourceText": section_text,
                    "provenance": text_provenance(
                        source_id="senateDirectory",
                        source_sha256=source_sha256,
                        page_number=page_number,
                        page_object_id=page_object_id(reader, page_number),
                        source_text=section_text,
                    ),
                }
            ]
            records[(inventory["chamber"], inventory["officialCode"])] = record

        if page_number == 30 and "LOCATION OF SENATE MEETING ROOMS" in lines:
            room_index = lines.index("LOCATION OF SENATE MEETING ROOMS") + 1
            for line in lines[room_index:]:
                match = re.match(r"^([^,]+),\s*(.+)$", line)
                if match:
                    meeting_rooms.append(
                        {"room": collapse_space(match.group(1)), "description": collapse_space(match.group(2))}
                    )

    found_senate_codes = {
        code for (chamber, code) in records if chamber == "senate"
    }
    expected_senate_codes = {
        row["officialCode"] for row in allowed if row["chamber"] == "senate"
    }
    missing_senate = sorted(expected_senate_codes - found_senate_codes)
    if missing_senate != ["RE"]:
        raise ValueError(f"Unexpected Senate committee inventory gaps: {missing_senate}")
    ambiguities.append(
        {
            "kind": "inventory-committee-not-present-in-senate-directory-pages",
            "officialCode": "RE",
            "name": "Reapportionment",
            "resolution": "left-unenriched; no PDF text was inferred",
        }
    )
    found_joint_codes = {code for (chamber, code) in records if chamber == "joint"}
    expected_joint_codes = {
        row["officialCode"] for row in allowed if row["chamber"] == "joint"
    }
    if found_joint_codes != expected_joint_codes:
        raise ValueError(
            "Senate directory joint committee coverage mismatch: "
            f"missing={sorted(expected_joint_codes - found_joint_codes)}"
        )
    return (
        sorted(records.values(), key=lambda item: (item["chamber"], item["name"])),
        ambiguities,
        meeting_rooms,
    )


def parse_senate_committee_section(lines: Sequence[str]) -> dict[str, Any]:
    text = dehyphenate_wrapped("\n".join(lines))
    location_match = re.search(r"^Location:\s*(.+)$", text, re.M)
    mailing_match = re.search(
        r"^Mailing Address:\s*(.+?)(?=^(?:Chair|Vice Chair|Alternating Chair|Members|\(\d{3}\)|Staff Director|Deputy Staff Director|Senior Attorney|Committee Administrative Assistant):?)",
        text,
        re.M | re.S,
    )
    leadership: list[dict[str, str]] = []
    for role, name in re.findall(r"^(Chair|Vice Chair|Alternating Chair):\s*Senator\s+(.+)$", text, re.M):
        leadership.append({"role": role, "name": collapse_space(name)})
    members_match = re.search(
        r"^Members:\s*(.+?)(?=^\(\d{3}\)|^Senate VOIP|^Staff Director:|^Deputy Staff Director:|^Senior Attorney:|^Committee Administrative Assistant:)",
        text,
        re.M | re.S,
    )
    members = split_roster_names(members_match.group(1)) if members_match else []
    staff: list[dict[str, str]] = []
    for role, name in re.findall(
        r"^(Staff Director|Deputy Staff Director|Senior Attorney|Committee Administrative Assistant):\s*(.+)$",
        text,
        re.M,
    ):
        staff.append({"role": role, "name": collapse_space(name)})
    return {
        "location": collapse_space(location_match.group(1)) if location_match else None,
        "mailingAddress": collapse_space(mailing_match.group(1)) if mailing_match else None,
        "phones": PHONE_RE.findall(text),
        "senateVoip": re.findall(r"Senate VOIP\s+(\d+)", text, re.I),
        "leadership": leadership,
        "roster": [{"name": name} for name in members],
        "staff": staff,
    }


@dataclass(frozen=True)
class ExtractionResult:
    manifest: dict[str, Any]
    portraits: dict[str, bytes]


def extract(
    house_pdf_path: Path,
    senate_pdf_path: Path,
    inventory_path: Path,
) -> ExtractionResult:
    for path in (house_pdf_path, senate_pdf_path, inventory_path):
        if not path.is_file():
            raise FileNotFoundError(path)

    inventory_bytes = inventory_path.read_bytes()
    inventory = json.loads(inventory_bytes.decode("utf-8"))
    inventory_rows = inventory["rows"]
    house_sha256 = sha256_file(house_pdf_path)
    senate_sha256 = sha256_file(senate_pdf_path)
    if house_sha256 != HOUSE_SHA256:
        raise ValueError(
            f"House directory hash mismatch: expected {HOUSE_SHA256}, got {house_sha256}"
        )
    if senate_sha256 != SENATE_SHA256:
        raise ValueError(
            f"Senate directory hash mismatch: expected {SENATE_SHA256}, got {senate_sha256}"
        )
    house_reader = PdfReader(house_pdf_path)
    senate_reader = PdfReader(senate_pdf_path)
    if len(house_reader.pages) != 182 or len(senate_reader.pages) != 33:
        raise ValueError(
            "Directory page-count mismatch: "
            f"house={len(house_reader.pages)}, senate={len(senate_reader.pages)}"
        )

    with pdfplumber.open(house_pdf_path) as house_pdf, pdfplumber.open(senate_pdf_path) as senate_pdf:
        house_members, portraits, member_ambiguities = parse_house_members(
            house_pdf, house_reader, house_sha256
        )
        house_committees, house_committee_ambiguities = parse_house_committees(
            house_pdf, house_reader, house_sha256, inventory_rows
        )
        house_office_pages = parse_office_directory_pages(
            house_pdf,
            house_reader,
            "houseDirectory",
            house_sha256,
            HOUSE_OFFICE_PAGES,
        )
        senate_members, senate_member_ambiguities = parse_senate_members(
            senate_pdf, senate_reader, senate_sha256
        )
        senate_committees, senate_committee_ambiguities, meeting_rooms = parse_senate_committees(
            senate_pdf, senate_reader, senate_sha256, inventory_rows
        )
        senate_office_pages = parse_office_directory_pages(
            senate_pdf,
            senate_reader,
            "senateDirectory",
            senate_sha256,
            SENATE_OFFICE_PAGES,
        )

    house_committee_codes = {item["officialCode"] for item in house_committees}
    senate_committee_codes = {
        item["officialCode"] for item in senate_committees if item["chamber"] == "senate"
    }
    house_joint_codes = {
        item["officialCode"] for item in house_committees if item["chamber"] == "joint"
    }
    senate_joint_codes = {
        item["officialCode"] for item in senate_committees if item["chamber"] == "joint"
    }
    inventory_coverage = [
        {
            "chamber": row["chamber"],
            "officialCode": row["officialCode"],
            "name": row["name"],
            "houseDirectory": (
                row["officialCode"] in house_committee_codes
                if row["chamber"] != "senate"
                else False
            ),
            "senateDirectory": (
                row["officialCode"] in senate_committee_codes
                if row["chamber"] == "senate"
                else row["officialCode"] in senate_joint_codes
            ),
        }
        for row in inventory_rows
    ]

    ambiguities = (
        member_ambiguities
        + house_committee_ambiguities
        + senate_member_ambiguities
        + senate_committee_ambiguities
        + [
            {
                "kind": "pending-election-house-profile-has-no-portrait",
                "district": member["district"],
                "pageNumber": member["provenance"]["pageNumber"],
                "resolution": "preserved as a vacant profile without inventing an image",
            }
            for member in house_members
            if member["vacant"]
        ]
    )

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "parserVersion": PARSER_VERSION,
        "jurisdiction": "FL",
        "legislativeSession": "2026",
        "purpose": "Additive Florida legislative-directory enrichment; fill missing fields only.",
        "sources": {
            "houseDirectory": {
                "filename": house_pdf_path.name,
                "sha256": house_sha256,
                "asOfDate": HOUSE_AS_OF_DATE,
                "byteLength": house_pdf_path.stat().st_size,
                "pageCount": len(house_reader.pages),
                "metadata": pdf_metadata(house_reader),
                "pageRanges": {
                    "committees": [HOUSE_COMMITTEE_PAGES.start, HOUSE_COMMITTEE_PAGES.stop - 1],
                    "members": [HOUSE_MEMBER_PAGES.start, HOUSE_MEMBER_PAGES.stop - 1],
                    "officesAndProfessionalStaff": [
                        HOUSE_OFFICE_PAGES.start,
                        HOUSE_OFFICE_PAGES.stop - 1,
                    ],
                },
            },
            "senateDirectory": {
                "filename": senate_pdf_path.name,
                "sha256": senate_sha256,
                "asOfDate": SENATE_AS_OF_DATE,
                "byteLength": senate_pdf_path.stat().st_size,
                "pageCount": len(senate_reader.pages),
                "metadata": pdf_metadata(senate_reader),
                "pageRanges": {
                    "members": [SENATE_MEMBER_PAGES.start, SENATE_MEMBER_PAGES.stop - 1],
                    "committees": [SENATE_COMMITTEE_PAGES.start, SENATE_COMMITTEE_PAGES.stop - 1],
                    "officesAndProfessionalStaff": list(SENATE_OFFICE_PAGES),
                },
            },
            "officialCommitteeInventory": {
                "filename": inventory_path.name,
                "sha256": sha256_bytes(inventory_bytes),
                "byteLength": len(inventory_bytes),
            },
        },
        "counts": {
            "houseMemberProfiles": len(house_members),
            "houseSeatedMemberProfiles": sum(not member["vacant"] for member in house_members),
            "housePendingElectionProfiles": sum(member["vacant"] for member in house_members),
            "housePortraits": len(portraits),
            "houseCommitteeProfiles": sum(
                committee["chamber"] == "house" for committee in house_committees
            ),
            "houseJointCommitteeProfiles": sum(
                committee["chamber"] == "joint" for committee in house_committees
            ),
            "senateMemberProfiles": len(senate_members),
            "senateVacantProfiles": sum(member["vacant"] for member in senate_members),
            "senateCommitteeProfiles": sum(
                committee["chamber"] == "senate" for committee in senate_committees
            ),
            "senateJointCommitteeProfiles": sum(
                committee["chamber"] == "joint" for committee in senate_committees
            ),
            "senateMeetingRooms": len(meeting_rooms),
            "houseOfficeDirectoryPages": len(house_office_pages),
            "senateOfficeDirectoryPages": len(senate_office_pages),
        },
        "house": {
            "members": house_members,
            "committees": house_committees,
            "officeDirectoryPages": house_office_pages,
        },
        "senate": {
            "members": senate_members,
            "committees": senate_committees,
            "meetingRooms": meeting_rooms,
            "officeDirectoryPages": senate_office_pages,
        },
        "inventoryCoverage": inventory_coverage,
        "ambiguities": ambiguities,
        "validation": {
            "houseDistrictsComplete": [member["district"] for member in house_members]
            == list(range(1, 121)),
            "housePortraitContract": len(portraits) == 118,
            "senateDistrictsComplete": [member["district"] for member in senate_members]
            == list(range(1, 41)),
            "houseOfficialCommitteeInventoryComplete": len(house_committee_codes) == 39,
            "senateDirectoryInventoryGapIsOnlyReapportionment": (
                {row["officialCode"] for row in inventory_rows if row["chamber"] == "senate"}
                - senate_committee_codes
            )
            == {"RE"},
            "jointCommitteesPresentInBothDirectories": house_joint_codes == senate_joint_codes,
        },
    }
    if not all(manifest["validation"].values()):
        failed = [key for key, value in manifest["validation"].items() if not value]
        raise ValueError(f"Extraction validation failed: {failed}")
    return ExtractionResult(manifest=manifest, portraits=portraits)


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def write_result(result: ExtractionResult, manifest_path: Path, portrait_dir: Path) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    portrait_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_bytes(canonical_json_bytes(result.manifest))
    for filename, image_bytes in sorted(result.portraits.items()):
        (portrait_dir / filename).write_bytes(image_bytes)


def check_result(result: ExtractionResult, manifest_path: Path, portrait_dir: Path) -> list[str]:
    errors: list[str] = []
    expected_manifest = canonical_json_bytes(result.manifest)
    if not manifest_path.is_file():
        errors.append(f"missing manifest: {manifest_path}")
    elif manifest_path.read_bytes() != expected_manifest:
        errors.append(f"manifest is stale: {manifest_path}")
    existing_portraits = {
        path.name for path in portrait_dir.glob("house-district-*.jpg") if path.is_file()
    }
    expected_portraits = set(result.portraits)
    if existing_portraits != expected_portraits:
        errors.append(
            "portrait filename set differs: "
            f"missing={sorted(expected_portraits - existing_portraits)}, "
            f"extra={sorted(existing_portraits - expected_portraits)}"
        )
    for filename, image_bytes in result.portraits.items():
        path = portrait_dir / filename
        if path.is_file() and path.read_bytes() != image_bytes:
            errors.append(f"portrait is stale: {path}")
    return errors


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--house-pdf", type=Path, default=DEFAULT_HOUSE_PDF)
    parser.add_argument("--senate-pdf", type=Path, default=DEFAULT_SENATE_PDF)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--output", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--portrait-dir", type=Path, default=DEFAULT_PORTRAIT_DIR)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Parse and validate sources, then fail if committed outputs are not byte-for-byte current.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    result = extract(args.house_pdf, args.senate_pdf, args.inventory)
    if args.check:
        errors = check_result(result, args.output, args.portrait_dir)
        if errors:
            for error in errors:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1
    else:
        write_result(result, args.output, args.portrait_dir)
    summary = result.manifest["counts"]
    print(json.dumps({"ok": True, "counts": summary, "ambiguities": len(result.manifest["ambiguities"])}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
