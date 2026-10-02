"""
curl_cffi wrapper for bypassing Cloudflare protection.
This script receives HTTP request details via stdin and outputs the response via stdout.
Supports session persistence and login functionality.
curl_cffi provides better Cloudflare bypass than cloudscraper by impersonating real browsers.
"""
from request_support import RateLimitedResponse, check_response, request_base_url, send, warmup, request_with_warmup, reset_request_metrics, with_request_metrics
import sys
import json
from typing import Dict, Optional
try:
    from curl_cffi import requests
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False
    sys.exit(1)
_session_instance: Optional[requests.Session] = None
_base_url: Optional[str] = None

def get_session(base_url: str) -> requests.Session:
    """Get or create a curl_cffi session with browser impersonation."""
    global _session_instance, _base_url
    if _session_instance is None or _base_url != base_url:
        _session_instance = requests.Session(impersonate='chrome110')
        _base_url = base_url
    return _session_instance

def fetch_csrf_token(session: requests.Session, base_url: str) -> Optional[str]:
    """Fetch CSRF token from /session/csrf.json."""
    try:
        response = send(session.get, f'{base_url}/session/csrf.json', timeout=10, headers={'Accept': 'application/json'})
        check_response(response)
        if response.status_code == 200:
            data = response.json()
            token = data.get('csrf')
            if token:
                session.headers['X-CSRF-Token'] = token
                return token
    except RateLimitedResponse:
        raise
    except Exception as e:
        pass
    return None

def login(session: requests.Session, base_url: str, username: str, password: str, second_factor_token: Optional[str]=None) -> Dict:
    """Login to Discourse forum."""
    try:
        csrf_token = fetch_csrf_token(session, base_url)
        if not csrf_token:
            return {'success': False, 'error': 'Failed to obtain CSRF token', 'error_type': 'AuthenticationError'}
        login_data = {'login': username, 'password': password, 'remember': True}
        if second_factor_token:
            login_data['second_factor_token'] = second_factor_token
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json', 'Referer': f'{base_url}/login', 'X-CSRF-Token': csrf_token, 'X-Requested-With': 'XMLHttpRequest'}
        response = send(session.post, f'{base_url}/session.json', json=login_data, headers=headers, timeout=30)
        check_response(response)
        if response.status_code == 200:
            result = response.json()
            return {'success': True, 'status': 200, 'body': json.dumps(result), 'message': 'Login successful', 'csrf_token': csrf_token}
        else:
            return {'success': False, 'status': response.status_code, 'error': f'Login failed with status {response.status_code}', 'error_type': 'AuthenticationError', 'body': response.text, 'headers': dict(response.headers)}
    except RateLimitedResponse:
        raise
    except Exception as e:
        return {'success': False, 'error': f'Login exception: {str(e)}', 'error_type': type(e).__name__}

def _make_request(data: Dict) -> Dict:
    """
    Make an HTTP request using curl_cffi.

    Args:
        data: Dictionary containing:
            - url: The URL to request
            - method: HTTP method (GET, POST, etc.)
            - headers: Dict of headers
            - body: Optional request body (for POST/PUT)
            - cookies: Optional dict of cookies
            - timeout: Optional timeout in seconds
            - login: Optional dict with 'username' and 'password' for authentication

    Returns:
        Dictionary containing:
            - success: Boolean indicating success/failure
            - status: HTTP status code
            - headers: Response headers
            - body: Response body (text)
            - cookies: Response cookies
            - csrf_token: CSRF token if available
            - error: Error message if failed
            - error_type: Error type if failed
    """
    url = data['url']
    base_url = request_base_url(data)
    session = get_session(base_url)
    if data.get('cookies'):
        session.cookies.update(data['cookies'])
    public_endpoints = ['/about.json', '/site.json', '/categories.json', '/tags.json', '/latest.json']
    is_public_endpoint = any((url.endswith(endpoint) or endpoint in url for endpoint in public_endpoints))
    should_login = False
    if data.get('login') and (not is_public_endpoint):
        login_info = data['login']
        username = login_info.get('username')
        password = login_info.get('password')
        has_session = False
        session_cookie_names = ['_t', '_forum_session', 'authentication_data']
        all_cookies = set(session.cookies.keys())
        if data.get('cookies'):
            all_cookies.update(data['cookies'].keys())
        for cookie_name in session_cookie_names:
            if cookie_name in all_cookies:
                has_session = True
                break
        if username and password and (not has_session):
            should_login = True
            warmup(session, base_url)
            second_factor = login_info.get('second_factor_token')
            login_result = login(session, base_url, username, password, second_factor)
            if not login_result.get('success'):
                pass
        elif has_session:
            pass
    elif is_public_endpoint and data.get('login'):
        pass
    try:
        response = request_with_warmup(session, base_url, method=data['method'], url=url, headers=data.get('headers', {}), data=data.get('body'), timeout=data.get('timeout', 30))
        cookies = {key: value for (key, value) in session.cookies.items()}
        csrf_token = session.headers.get('X-CSRF-Token')
        try:
            body_text = response.text
            if body_text.strip().startswith('{') or body_text.strip().startswith('['):
                pass
        except RateLimitedResponse:
            raise
        except Exception as e:
            body_text = response.content.decode('utf-8', errors='replace')
        return {'success': True, 'status': response.status_code, 'headers': dict(response.headers), 'body': body_text, 'cookies': cookies, 'csrf_token': csrf_token, 'logged_in': should_login}
    except RateLimitedResponse:
        raise
    except Exception as e:
        error_msg = str(e)
        error_type = type(e).__name__
        return {'success': False, 'error': error_msg, 'error_type': error_type}

def make_request(data: Dict) -> Dict:
    reset_request_metrics()
    try:
        result = _make_request(data)
    except RateLimitedResponse as limited:
        result = limited.result
    except (ValueError, TypeError, KeyError):
        result = {"success": False, "error": "Invalid request site URL", "error_type": "InvalidSiteError"}
    return with_request_metrics(result)

def main():
    """Main entry point - reads from stdin, processes request, writes to stdout."""
    try:
        input_data = json.loads(sys.stdin.read())
        result = make_request(input_data)
        output = json.dumps(result, ensure_ascii=True)
        sys.stdout.write(output)
        sys.stdout.flush()
        exit_code = 0 if result.get('success') else 1
        sys.exit(exit_code)
    except RateLimitedResponse:
        raise
    except json.JSONDecodeError as e:
        error_result = {'success': False, 'error': f'Invalid JSON input: {str(e)}', 'error_type': 'JSONDecodeError'}
        output = json.dumps(error_result, ensure_ascii=True)
        sys.stdout.write(output)
        sys.stdout.flush()
        sys.exit(1)
    except Exception as e:
        error_result = {'success': False, 'error': str(e), 'error_type': type(e).__name__}
        output = json.dumps(error_result, ensure_ascii=True)
        sys.stdout.write(output)
        sys.stdout.flush()
        sys.exit(1)
if __name__ == '__main__':
    main()
