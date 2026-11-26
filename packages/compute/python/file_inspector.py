"""Return a bounded JSON preview of a scientific file."""

import base64
import itertools
import json
import os
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROWS = 30
COLUMNS = 256
CELL_LIMIT = 2048
PREVIEW_LIMIT = 65536


def tag_name(element):
    return element.tag.rsplit("}", 1)[-1]


def xml_records(stream, name):
    stack = []
    for event, element in ET.iterparse(stream, events=("start", "end")):
        if event == "start":
            stack.append(element)
            continue
        if tag_name(element) == name:
            yield element
            if len(stack) > 1:
                stack[-2].remove(element)
        stack.pop()


def rich_text(element):
    return "".join(text.text or "" for child in element if tag_name(child) in {"r", "t"}
                   for text in child.iter() if tag_name(text) == "t")[:CELL_LIMIT]


def column_index(reference):
    value = 0
    for letter in reference:
        if not "A" <= letter <= "Z":
            break
        value = value * 26 + ord(letter) - ord("A") + 1
    return value - 1


def read_xlsx(path):
    with zipfile.ZipFile(path) as archive:
        with archive.open("xl/workbook.xml") as stream:
            sheets = list(xml_records(stream, "sheet"))
        result = {"sheets": [sheet.get("name", "") for sheet in sheets]}
        if not sheets:
            return {**result, **table_preview([], [])}
        sheet_id = next((value for key, value in sheets[0].attrib.items() if key.endswith("}id")), None)
        sheet_path = "xl/worksheets/sheet1.xml"
        if sheet_id and "xl/_rels/workbook.xml.rels" in archive.namelist():
            with archive.open("xl/_rels/workbook.xml.rels") as stream:
                for rel in xml_records(stream, "Relationship"):
                    if rel.get("Id") == sheet_id and rel.get("TargetMode") != "External":
                        target = rel.attrib["Target"]
                        sheet_path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
                        break

        rows = []
        shared_indices = set()
        with archive.open(sheet_path) as stream:
            for row in itertools.islice(xml_records(stream, "row"), ROWS + 1):
                values = []
                for cell in row:
                    if tag_name(cell) != "c":
                        continue
                    index = column_index(cell.get("r", ""))
                    index = len(values) if index < 0 else index
                    if index >= COLUMNS:
                        continue
                    kind = cell.get("t")
                    value = next((child for child in cell if tag_name(child) in {"v", "is"}), None)
                    text = "" if value is None else rich_text(value) if kind == "inlineStr" else (value.text or "")[:CELL_LIMIT]
                    if kind == "s" and text.isdecimal():
                        text = int(text)
                        shared_indices.add(text)
                    elif kind == "b":
                        text = {"1": "TRUE", "0": "FALSE"}.get(text, text)
                    values.extend([""] * (index + 1 - len(values)))
                    values[index] = text
                rows.append(values)

        shared = {}
        if shared_indices and "xl/sharedStrings.xml" in archive.namelist():
            with archive.open("xl/sharedStrings.xml") as stream:
                for index, item in enumerate(xml_records(stream, "si")):
                    if index in shared_indices:
                        shared[index] = rich_text(item)
                        if len(shared) == len(shared_indices):
                            break
        width = max(map(len, rows), default=0)
        rows = [[shared.get(value, "") if isinstance(value, int) else value for value in row] +
                [""] * (width - len(row)) for row in rows]
        return {**result, **table_preview(rows[0] if rows else [], rows[1:])}


def table_preview(headers, rows):
    cells = len(headers) + sum(map(len, rows))
    cell_limit = min(CELL_LIMIT, (1024 * 1024) // max(1, cells))
    headers = [value[:cell_limit] for value in headers]
    rows = [[value[:cell_limit] for value in row] for row in rows]
    lines = ("\t".join(row) for row in itertools.chain([headers], rows))
    preview = ""
    for line in lines:
        preview += ("\n" if preview else "") + line
        if len(preview) >= PREVIEW_LIMIT:
            break
    return {"headers": headers, "rows": rows, "previewText": preview[:PREVIEW_LIMIT]}


def read_vcf(path):
    headers, rows, metadata = [], [], []
    count = metadata_size = 0
    with open(path, encoding="utf-8-sig", errors="replace") as stream:
        for line in stream:
            line = line.rstrip("\r\n")
            if line.startswith("##"):
                if metadata_size < PREVIEW_LIMIT:
                    metadata.append(line[:PREVIEW_LIMIT - metadata_size])
                    metadata_size += len(line) + 1
            elif line.startswith("#CHROM\t"):
                headers = line[1:].split("\t", COLUMNS)[:COLUMNS]
            elif line and not line.startswith("#"):
                count += 1
                if len(rows) < ROWS:
                    rows.append([item[:CELL_LIMIT] for item in line.split("\t", COLUMNS)[:COLUMNS]])
    return {**table_preview(headers, rows), "structuredMetadata": {"variantCount": count, "headerLines": metadata}}


def molecule_counts(line):
    if len(line) >= 6 and line[:3].strip().isdigit() and line[3:6].strip().isdigit():
        return [line[:3].strip(), line[3:6].strip()]
    values = line.split()
    return values[:2] if len(values) >= 2 and all(value.isdigit() for value in values[:2]) else ["", ""]


def read_molecules(path, mol2=False):
    count = 0
    records = []
    properties = {}
    title = None
    counts = ["", ""]
    index = 0
    current_property = None
    active = not mol2
    with open(path, encoding="utf-8-sig", errors="replace") as stream:
        for raw_line in itertools.chain(stream, ["@<TRIPOS>MOLECULE" if mol2 else "$$$$"]):
            line = raw_line.rstrip("\r\n")
            if line.strip() == ("@<TRIPOS>MOLECULE" if mol2 else "$$$$"):
                if index >= (2 if mol2 else 4):
                    count += 1
                    if len(records) < ROWS:
                        records.append((title, counts, properties))
                title, counts, properties, index, current_property = None, ["", ""], {}, 0, None
                active = True
                continue
            if not active:
                continue
            if len(records) < ROWS:
                if index == 0:
                    title = line[:CELL_LIMIT]
                elif index == (1 if mol2 else 3):
                    counts = molecule_counts(line)
                elif not mol2:
                    match = re.match(r"M\s+V30\s+COUNTS\s+(\d+)\s+(\d+)", line)
                    property_tag = re.match(r"^>[^<]*<([^>]+)>", line)
                    if match:
                        counts = list(match.groups())
                    elif property_tag and len(properties) < COLUMNS - 3:
                        current_property = property_tag[1][:CELL_LIMIT]
                        properties[current_property] = ""
                    elif not line.strip():
                        current_property = None
                    elif current_property:
                        previous = properties[current_property]
                        properties[current_property] = ((previous + "\n" if previous else "") + line)[:CELL_LIMIT]
            index += 1
    fields = list(dict.fromkeys(key for _, _, properties in records for key in properties))[:COLUMNS - 3]
    headers = ["title", "atomCount", "bondCount", *fields]
    rows = [[title, *counts, *(properties.get(key, "") for key in fields)] for title, counts, properties in records]
    return {**table_preview(headers, rows), "structuredMetadata": {"moleculeCount": count}}


def pdf_string_bytes(token):
    if token.startswith(b"<"):
        hex_text = re.sub(rb"\s+", b"", token[1:-1])
        data = bytes.fromhex((hex_text + b"0" * (len(hex_text) % 2)).decode("ascii"))
    else:
        escapes = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f"}

        def unescape(match):
            value = match[1]
            if value[:1] in b"01234567":
                return bytes([int(value, 8) & 255])
            return b"" if value in (b"\r\n", b"\r", b"\n") else escapes.get(value, value)

        data = re.sub(rb"\\([0-7]{1,3}|\r\n|.)", unescape, token[1:-1], flags=re.S)
    return data


def pdf_string(token):
    data = pdf_string_bytes(token)
    return data.decode("utf-16" if data.startswith((b"\xfe\xff", b"\xff\xfe")) else "cp1252", errors="replace")


PDF_STRING = rb"\((?:\\[\s\S]|[^()\\]|\((?:\\[\s\S]|[^()\\])*\))*\)|<[\da-fA-F\s]+>"
PDF_SHOW_TEXT = re.compile(rb"(" + PDF_STRING + rb")\s*(?:Tj\b|['\"])|\[([^\]]*)\]\s*TJ\b")
PDF_REF = rb"(\d+)\s+(\d+)\s+R\b"
PDF_OBJECT = re.compile(rb"(?<!\S)(\d+)\s+(\d+)\s+obj\b")
PDF_STREAM = re.compile(rb">>\s*stream(?:\r\n|\r|\n)")
PDF_CONTENT_TOKEN = re.compile(rb"%[^\r\n]*|" + PDF_STRING + rb"|\[|\]|/?[^\s()<>\[\]{}/%]+")


def pdf_refs(value):
    return [(int(number), int(generation)) for number, generation in re.findall(PDF_REF, value)]


def pdf_stream(body):
    marker = PDF_STREAM.search(body)
    if marker is None:
        return None
    descriptor = body[:marker.end()]
    length = re.search(rb"/Length\s+(\d+)\b(?!\s+\d+\s+R\b)", descriptor)
    end = body.rfind(b"endstream")
    if length is not None and marker.end() + int(length[1]) <= end:
        content = body[marker.end():marker.end() + int(length[1])]
    elif end >= 0:
        content = body[marker.end():end].removesuffix(b"\n").removesuffix(b"\r")
    else:
        return None
    filters = re.search(rb"/Filter\s*(\[[^\]]*\]|/[A-Za-z0-9]+)", descriptor)
    try:
        for name in re.findall(rb"/([A-Za-z0-9]+)", filters[1] if filters else b""):
            if name in {b"FlateDecode", b"Fl"}:
                decoder = zlib.decompressobj()
                content = decoder.decompress(content, 64 * 1024 * 1024)
                if not decoder.eof:
                    return None
            elif name in {b"ASCII85Decode", b"A85"}:
                padded = re.sub(rb"\s+", b"", content).removeprefix(b"<~").removesuffix(b"~>")
                content = base64.a85decode(padded)
            elif name in {b"ASCIIHexDecode", b"AHx"}:
                hex_text = re.sub(rb"\s+", b"", content).split(b">", 1)[0]
                content = bytes.fromhex((hex_text + b"0" * (len(hex_text) % 2)).decode("ascii"))
            else:
                return None
    except (ValueError, zlib.error):
        return None
    return content


def pdf_objects(data):
    objects = {}
    offset = 0
    while match := PDF_OBJECT.search(data, offset):
        end = data.find(b"endobj", match.end())
        if end == -1:
            break
        stream = PDF_STREAM.search(data, match.end(), end)
        if stream is not None:
            length = re.search(rb"/Length\s+(\d+)\b(?!\s+\d+\s+R\b)", data[match.end():stream.start()])
            start = stream.end() + int(length[1]) if length else stream.end()
            stream_end = data.find(b"endstream", start)
            if stream_end != -1:
                following = data.find(b"endobj", stream_end)
                if following != -1:
                    end = following
        objects[(int(match[1]), int(match[2]))] = data[match.end():end].strip()
        offset = end + len(b"endobj")

    for body in list(objects.values()):
        descriptor = PDF_STREAM.split(body, maxsplit=1)[0]
        if not re.search(rb"/Type\s*/ObjStm\b", descriptor):
            continue
        first = re.search(rb"/First\s+(\d+)\b", descriptor)
        content = pdf_stream(body)
        if first is None or content is None:
            continue
        first = int(first[1])
        if not re.fullmatch(rb"[\d\s]*", content[:first]):
            continue
        offsets = list(map(int, content[:first].split()))
        for index in range(0, len(offsets) - 1, 2):
            number, start = offsets[index:index + 2]
            end = first + offsets[index + 3] if index + 3 < len(offsets) else len(content)
            objects.setdefault((number, 0), content[first + start:end].strip())
    return objects


def pdf_unicode_map(body):
    mapping = {}
    hex_token = rb"<([\da-fA-F]+)>"
    for entries in re.findall(rb"beginbfchar([\s\S]*?)endbfchar", body):
        for source, destination in re.findall(hex_token + rb"\s*" + hex_token, entries):
            mapping[bytes.fromhex(source.decode())] = bytes.fromhex(destination.decode()).decode("utf-16-be", "replace")
    ranges = hex_token + rb"\s*" + hex_token + rb"\s*(" + hex_token + rb"|\[[^\]]*\])"
    for entries in re.findall(rb"beginbfrange([\s\S]*?)endbfrange", body):
        for start, end, destination, single in re.findall(ranges, entries):
            first, last = int(start, 16), int(end, 16)
            if last - first > 65535 or len(start) != len(end):
                continue
            width = len(start) // 2
            if single:
                value = int(single, 16)
                size = len(single) // 2
                available = min(last - first + 1, (1 << (size * 8)) - value)
                codes = ((value + index).to_bytes(size, "big") for index in range(available))
            else:
                codes = (bytes.fromhex(code.decode()) for code in re.findall(hex_token, destination))
            for offset, code in enumerate(itertools.islice(codes, last - first + 1)):
                mapping[(first + offset).to_bytes(width, "big")] = code.decode("utf-16-be", "replace")
    return mapping


def pdf_page_fonts(objects, ref, cache):
    visited = set()
    while ref is not None and ref not in visited:
        visited.add(ref)
        body = objects.get(ref, b"")
        resources = re.search(rb"/Resources\s*(<<|" + PDF_REF + rb")", body)
        if resources is not None:
            body = body[resources.start():] if resources[1] == b"<<" else objects.get(pdf_refs(resources[1])[0], b"")
            font = re.search(rb"/Font\s*(<<[\s\S]*?>>|" + PDF_REF + rb")", body)
            if font is None:
                return {}
            dictionary = font[1] if font[1].startswith(b"<<") else objects.get(pdf_refs(font[1])[0], b"")
            encodings = {}
            for name, number, generation in re.findall(rb"(/[^\s<>/]+)\s+" + PDF_REF, dictionary):
                font_ref = (int(number), int(generation))
                if font_ref not in cache:
                    unicode_ref = re.search(rb"/ToUnicode\s+" + PDF_REF, objects.get(font_ref, b""))
                    if unicode_ref is None:
                        cache[font_ref] = {}
                    else:
                        cmap = pdf_stream(objects.get((int(unicode_ref[1]), int(unicode_ref[2])), b"")) or b""
                        try:
                            cache[font_ref] = pdf_unicode_map(cmap)
                        except (ValueError, OverflowError):
                            cache[font_ref] = {}
                encodings[name] = cache[font_ref]
            return encodings
        parent = re.search(rb"/Parent\s+" + PDF_REF, body)
        ref = (int(parent[1]), int(parent[2])) if parent else None
    return {}


def pdf_page_text(content, fonts):
    lines = []
    line = []
    operands = []
    in_text = False
    encoding = {}
    widths = []

    def finish_line():
        if line:
            lines.append("".join(line))
            line.clear()

    def decode(token):
        if not encoding:
            return pdf_string(token)
        data = pdf_string_bytes(token)
        offset = 0
        result = []
        while offset < len(data):
            for width in widths:
                value = encoding.get(data[offset:offset + width])
                if value is not None and offset + width <= len(data):
                    result.append(value)
                    offset += width
                    break
            else:
                result.append("\ufffd")
                offset += min(widths)
        return "".join(result)

    for match in PDF_CONTENT_TOKEN.finditer(content):
        token = match[0]
        if token == b"BT":
            in_text = True
        elif token == b"ET":
            in_text = False
            finish_line()
        elif not in_text or token.startswith(b"%"):
            continue
        elif token == b"Tf":
            encoding = fonts.get(operands[-2], {}) if len(operands) >= 2 else {}
            widths = sorted({len(code) for code in encoding}, reverse=True)
        elif token in (b"T*", b"Td", b"TD", b"Tm"):
            finish_line()
        elif token in (b"Tj", b"TJ", b"'", b'"'):
            if token in (b"'", b'"'):
                finish_line()
            for operand in operands:
                if operand.startswith((b"(", b"<")):
                    line.append(decode(operand))
                elif token == b"TJ" and line and re.fullmatch(rb"-\d+(?:\.\d+)?", operand) and float(operand) < -120:
                    if not line[-1].endswith(" "):
                        line.append(" ")
        elif token.startswith((b"(", b"<", b"/")) or re.fullmatch(rb"[+-]?[\d.]+|\[|\]", token):
            operands.append(token)
            continue
        operands.clear()
    finish_line()
    return "\n".join(lines)


def read_basic_pdf_pages(path):
    with open(path, "rb") as stream:
        data = stream.read()
    if not data.startswith(b"%PDF-"):
        raise ValueError("Invalid PDF file signature")
    objects = pdf_objects(data)
    page_refs = []
    roots = re.findall(rb"/Root\s+" + PDF_REF, data)
    catalog = objects.get(tuple(map(int, roots[-1])), b"") if roots else b""
    if not catalog:
        catalog = next((body for body in objects.values() if re.search(rb"/Type\s*/Catalog\b", body)), b"")
    root = re.search(rb"/Pages\s+" + PDF_REF, catalog)
    pending = pdf_refs(root[0]) if root else []
    visited = set()
    while pending:
        ref = pending.pop()
        if ref in visited:
            continue
        visited.add(ref)
        body = objects.get(ref, b"")
        if re.search(rb"/Type\s*/Page\b", body):
            page_refs.append(ref)
        else:
            kids = re.search(rb"/Kids\s*(\[[^\]]*\]|" + PDF_REF + rb")", body)
            if kids:
                value = kids[1]
                if not value.startswith(b"["):
                    value = objects.get(pdf_refs(value)[0], b"")
                pending.extend(reversed(pdf_refs(value)))
    if not page_refs:
        page_refs = [ref for ref, body in objects.items() if re.search(rb"/Type\s*/Page\b", body.split(b"stream", 1)[0])]
    if not page_refs:
        raise ValueError("No PDF page objects were found")

    texts = []
    font_cache = {}
    for ref in page_refs:
        body = objects[ref]
        contents = re.search(rb"/Contents\s*(\[[^\]]*\]|" + PDF_REF + rb")", body)
        parts = []
        if contents:
            for stream_ref in pdf_refs(contents[1]):
                value = objects.get(stream_ref, b"")
                if value.startswith(b"["):
                    parts.extend(pdf_stream(objects.get(part, b"")) or b"" for part in pdf_refs(value))
                else:
                    parts.append(pdf_stream(value) or b"")
        texts.append(pdf_page_text(b"\n".join(parts), pdf_page_fonts(objects, ref, font_cache)))
    info_refs = re.findall(rb"/Info\s+" + PDF_REF, data)
    info = objects.get(tuple(map(int, info_refs[-1])), b"") if info_refs else b""
    title = re.search(rb"/Title\s*(" + PDF_STRING + rb")", info)
    return pdf_pages_result(texts, pdf_string(title[1]) if title else None)


def pdf_pages_result(texts, title):
    pages = [{"page": page, "text": text} for page, text in enumerate(texts, 1)]
    result = {"pageCount": len(pages), "pages": pages}
    if isinstance(title, str) and title.strip():
        result["title"] = title
    return result


def read_pdf_pages(path):
    empty_result = None
    try:
        from pypdf import PdfReader

        reader = PdfReader(path)
        result = pdf_pages_result((page.extract_text() or "" for page in reader.pages), (reader.metadata or {}).get("/Title"))
        if any(page["text"].strip() for page in result["pages"]):
            return result
        empty_result = result
    except Exception:
        pass
    try:
        import fitz

        with fitz.open(path) as reader:
            result = pdf_pages_result((page.get_text() for page in reader), (reader.metadata or {}).get("title"))
            if any(page["text"].strip() for page in result["pages"]):
                return result
            empty_result = empty_result or result
    except Exception:
        pass
    try:
        result = read_basic_pdf_pages(path)
        if empty_result and not any(page["text"].strip() for page in result["pages"]):
            return empty_result
        return result
    except ValueError:
        if empty_result is not None:
            return empty_result
        raise


def read_basic_pdf(path):
    scan_limit = 32 * 1024 * 1024
    with open(path, "rb") as stream:
        data = stream.read(scan_limit + 1)
    if not data.startswith(b"%PDF-"):
        raise ValueError("Invalid PDF file signature")
    pages = re.findall(rb"/Type\s*/Page\b", data)
    counts = [int(count) for count in re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", data)]
    text = []
    length = 0
    for match in re.finditer(rb"(<<(?:(?!>>)[\s\S])*?>>)\s*stream\r?\n([\s\S]*?)\r?\n?endstream\b", data[:scan_limit]):
        descriptor, content = match.groups()
        if b"/FlateDecode" in descriptor:
            try:
                content = zlib.decompressobj().decompress(content, 2 * 1024 * 1024)
            except zlib.error:
                continue
        elif b"/Filter" in descriptor:
            continue
        for block in re.finditer(rb"\bBT\b([\s\S]*?)\bET\b", content):
            for operator in PDF_SHOW_TEXT.finditer(block[1]):
                tokens = [operator[1]] if operator[1] else re.findall(PDF_STRING, operator[2])
                line = "".join(pdf_string(token) for token in tokens)
                text.append(line)
                length += len(line) + 1
                if length >= PREVIEW_LIMIT:
                    break
            if length >= PREVIEW_LIMIT:
                break
        if length >= PREVIEW_LIMIT:
            break
    result = {"previewText": "\n".join(text)[:PREVIEW_LIMIT]}
    page_count = max([len(pages), *counts])
    if page_count:
        result["pageCount"] = page_count
    if not text:
        result["structuredMetadata"] = {"detail": "No PDF text found by the basic extractor. Install pypdf for expanded PDF support."}
    if len(data) > scan_limit:
        result.setdefault("structuredMetadata", {})["scanTruncated"] = True
    return result


def read_pdf(path):
    page_count = None
    try:
        from pypdf import PdfReader

        reader = PdfReader(path)
        page_count = len(reader.pages)
        text = "\n".join((page.extract_text() or "")[:PREVIEW_LIMIT] for page in itertools.islice(reader.pages, ROWS))
        if text.strip():
            return {"pageCount": page_count, "previewText": text[:PREVIEW_LIMIT]}
    except Exception:
        pass
    try:
        import fitz

        with fitz.open(path) as reader:
            page_count = len(reader)
            text = "\n".join(page.get_text()[:PREVIEW_LIMIT] for page in itertools.islice(reader, ROWS))
            if text.strip():
                return {"pageCount": page_count, "previewText": text[:PREVIEW_LIMIT]}
    except Exception:
        pass
    result = read_basic_pdf(path)
    if page_count is not None:
        result["pageCount"] = page_count
    return result


def read_h5ad(path):
    signature_offset = None
    with open(path, "rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        offset = 0
        while offset + 8 <= size:
            stream.seek(offset)
            if stream.read(8) == b"\x89HDF\r\n\x1a\n":
                signature_offset = offset
                break
            offset = offset * 2 if offset else 512
    if signature_offset is None:
        raise ValueError("Invalid HDF5 file signature")
    metadata = {"container": "HDF5", "signatureOffset": signature_offset}
    try:
        import h5py
    except (ImportError, OSError, ValueError):
        metadata["detail"] = "Install h5py to inspect AnnData dimensions and columns."
        return {"structuredMetadata": metadata, "previewText": ""}
    try:
        with h5py.File(path, "r") as file:
            def local_object(group, name):
                link = group.get(name, getlink=True)
                return group.get(name) if isinstance(link, h5py.HardLink) else None

            matrix = local_object(file, "X")
            shape = getattr(matrix, "shape", None) if matrix is not None else None
            if shape is None and matrix is not None:
                shape = matrix.attrs.get("shape")
            if shape is not None and len(shape) == 2:
                metadata.update(nObs=int(shape[0]), nVars=int(shape[1]))
            for axis, dimension in (("obs", "nObs"), ("var", "nVars")):
                frame = local_object(file, axis)
                if isinstance(frame, h5py.Group):
                    index = frame.attrs.get("_index", "_index")
                    columns = frame.attrs.get("column-order")
                    if columns is None:
                        columns = (column for column in frame.keys() if column != index)
                    metadata[axis + "Columns"] = [str(column, "utf-8", "replace") if isinstance(column, bytes) else str(column)
                                                  for column in itertools.islice(columns, COLUMNS)]
                    if isinstance(index, bytes):
                        index = index.decode("utf-8", errors="replace")
                    ids = local_object(frame, index)
                    if dimension not in metadata and getattr(ids, "shape", None):
                        metadata[dimension] = len(ids)
    except (OSError, ValueError) as error:
        metadata["detail"] = f"Could not inspect the AnnData structure: {error}"
    return {"structuredMetadata": metadata, "previewText": ""}


def read_parquet(path):
    with open(path, "rb") as stream:
        if stream.read(4) != b"PAR1":
            raise ValueError("Invalid Parquet file signature")
        stream.seek(-8, 2)
        footer_offset = stream.tell()
        footer_size = int.from_bytes(stream.read(4), "little")
        if stream.read(4) != b"PAR1" or not 0 < footer_size <= footer_offset - 4:
            raise ValueError("Invalid Parquet metadata footer")
    metadata = {"container": "Parquet", "footerSizeBytes": footer_size}
    try:
        import pyarrow.parquet as parquet
    except (ImportError, OSError, ValueError):
        metadata["detail"] = "Install pyarrow to inspect the Parquet schema and rows."
        return {"structuredMetadata": metadata, "previewText": ""}
    file = parquet.ParquetFile(path)
    try:
        schema = file.schema_arrow
        headers = schema.names[:COLUMNS]
        metadata.update(rowCount=file.metadata.num_rows, rowGroupCount=file.metadata.num_row_groups,
                        schema=[{"name": field.name, "type": str(field.type)} for field in itertools.islice(schema, COLUMNS)])
        rows = []
        for batch in file.iter_batches(batch_size=ROWS, columns=headers):
            for row in itertools.islice(batch.to_pylist(), ROWS - len(rows)):
                rows.append([str(row[name])[:CELL_LIMIT] if row.get(name) is not None else "" for name in headers])
            if len(rows) == ROWS:
                break
        return {**table_preview(headers, rows), "structuredMetadata": metadata}
    finally:
        file.close()


if __name__ == "__main__":
    readers = {"xlsx": read_xlsx, "pdf": read_pdf, "pdf-pages": read_pdf_pages, "vcf": read_vcf, "sdf": read_molecules,
               "mol2": lambda path: read_molecules(path, mol2=True), "h5ad": read_h5ad, "parquet": read_parquet}
    kind, path = sys.argv[1:]
    try:
        result = readers[kind](path)
    except Exception as error:
        if kind == "pdf-pages":
            sys.exit(f"Could not extract PDF pages: {error}")
        result = {"previewText": "", "structuredMetadata": {"detail": f"Could not preview {kind}: {error}"}}
    print(json.dumps(result))
