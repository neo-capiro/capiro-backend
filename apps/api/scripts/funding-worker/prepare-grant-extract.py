"""Convert an official Grants.gov ZIP extract into streaming JSONL for gap repair.

Downloads only the dated official extract, verifies the ZIP CRC, and records the
archive SHA-256. No credentials or database access. The canonical funding writer
imports this file with --grant-extract=s3://BUCKET/funding-source-documents/KEY.
"""
import argparse
import datetime
import hashlib
import json
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def prepare(archive, output, extract_date):
    stamp = datetime.datetime.strptime(extract_date, '%Y%m%d').strftime('%Y%m%d')
    name = f'GrantsDBExtract{stamp}v2.zip'
    url = f'https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/{name}'
    if not archive.exists():
        urllib.request.urlretrieve(url, archive)
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    manifest = {'format': 'grants-gov-gap-repair-v1', 'sourceUrl': url,
                'extractDate': stamp, 'archiveSha256': digest}
    count = 0
    with zipfile.ZipFile(archive) as z, output.open('x', encoding='utf-8') as out:
        xml_name = f'GrantsDBExtract{stamp}v2.xml'
        if z.namelist() != [xml_name] or z.getinfo(xml_name).file_size > 1024**3:
            raise ValueError('Unexpected extract contents')
        out.write(json.dumps(manifest) + '\n')
        with z.open(xml_name) as stream:
            for _, element in ET.iterparse(stream, events=['end']):
                if element.tag.rsplit('}', 1)[-1] != 'OpportunitySynopsisDetail_1_0':
                    continue
                fields = {}
                for child in element:
                    key = child.tag.rsplit('}', 1)[-1]
                    fields.setdefault(key, []).append(child.text or '')
                out.write(json.dumps(fields, ensure_ascii=False) + '\n')
                count += 1
                element.clear()
    print(json.dumps({**manifest, 'records': count, 'jsonlBytes': output.stat().st_size}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', required=True, help='Official extract date YYYYMMDD')
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New JSONL filename')
    args = parser.parse_args()
    prepare(args.archive, args.output, args.date)
