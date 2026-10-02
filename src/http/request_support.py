"""Response classification shared by both Python HTTP backends."""
import json
import re
import sys

_metrics = {"explicit_request_count": 0, "warmup_request_count": 0}

def reset_request_metrics():
    for key in _metrics:
        _metrics[key] = 0

def send(call, *args, phase="target", **kwargs):
    # Explicit helper calls only; library redirects/internal retries are excluded.
    _metrics["explicit_request_count"] += 1
    if phase == "warmup":
        _metrics["warmup_request_count"] += 1
    return call(*args, **kwargs)

def with_request_metrics(result):
    return {**result, **_metrics}

def warmup(session, base_url, timeout=15):
    try:
        response = send(session.get, base_url, phase="warmup", timeout=timeout, allow_redirects=True)
        check_response(response)
        return True
    except RateLimitedResponse:
        raise
    except Exception:
        return False

def request_with_warmup(session, base_url, **kwargs):
    response = send(session.request, **kwargs)
    check_response(response)
    body = response_body(response)
    headers = {str(k).lower(): str(v).lower() for k, v in response.headers.items()}
    challenge = headers.get("cf-mitigated") == "challenge" or (
        response.status_code in (200, 403, 503) and
        bool(re.match(r"\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b", body, re.I)) and
        bool(re.search(r"<title[^>]*>\s*(?:just a moment|attention required)|/cdn-cgi/challenge-platform", body, re.I)))
    if kwargs.get("method", "GET").upper() == "GET" and challenge:
        if warmup(session, base_url, min(15, kwargs.get("timeout", 15))):
            response = send(session.request, **kwargs)
            check_response(response)
    return response

class RateLimitedResponse(Exception):
    def __init__(self, response):
        super().__init__("Rate limited")
        self.result = {
            "success": False,
            "status": response.status_code,
            "headers": dict(response.headers),
            "body": response_body(response),
            "error": "Rate limited",
            "error_type": "RateLimitError",
        }

def response_body(response):
    try:
        return response.text
    except Exception:
        return ""

def check_response(response):
    # A status is safe operational data. Never log headers, body or exceptions.
    print(json.dumps({"event": "python.response", "status": response.status_code}), file=sys.stderr)
    if response.status_code == 429:
        raise RateLimitedResponse(response)
    body = response_body(response)
    error1015 = re.search(r"\berror\s*(?:code\s*[:=]?\s*)?1015\b", body, re.I)
    challenge1015 = re.search(r"<(?:title|h1)[^>]*>\s*error\s*(?:code\s*[:=]?\s*)?1015\b", body, re.I)
    if (response.status_code >= 400 and error1015) or (re.match(r"\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b", body, re.I) and challenge1015):
        raise RateLimitedResponse(response)


def request_base_url(data):
    """Explicit installation base; legacy callers without it retain root behavior."""
    from urllib.parse import urlsplit, urlunsplit, unquote
    target = urlsplit(data['url'])
    base = urlsplit(data.get('site_base') or '{}://{}'.format(target.scheme, target.netloc))
    if target.scheme not in ('http', 'https') or base.scheme not in ('http', 'https') or target.username or target.password or base.username or base.password:
        raise ValueError('Invalid site URL')
    def port(url):
        return url.port or (443 if url.scheme == 'https' else 80)
    try:
        same_origin = target.scheme == base.scheme and target.hostname == base.hostname and port(target) == port(base)
    except ValueError:
        raise ValueError('Invalid site URL')
    if any(segment in ('.', '..') for path in (target.path, base.path) for segment in unquote(path).replace(chr(92), '/').split('/')):
        raise ValueError('Request URL must have a canonical site path')
    prefix = base.path.rstrip('/')
    if not same_origin or not base.hostname or not (target.path == prefix or target.path.startswith(prefix + '/')):
        raise ValueError('Request URL is outside the configured site')
    return urlunsplit((base.scheme, base.netloc, prefix, '', ''))
