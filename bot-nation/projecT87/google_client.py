import os
import json
import logging
import requests
import time
import base64
import subprocess
import tempfile
from typing import Optional, Dict, List, Any

logger = logging.getLogger(__name__)

SERVICE_ACCOUNT_SECRET_KEY = "GOOGLE_SERVICE_ACCOUNT_JSON"

SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive",
]


class GoogleClient:
    def __init__(self):
        self.credentials = None
        self.access_token = None
        self.token_expiry = 0
        self.service_account_email = None
        self._load_credentials()

    def _load_credentials(self):
        creds_json = os.getenv(SERVICE_ACCOUNT_SECRET_KEY)
        if not creds_json:
            logger.warning(
                f"No Google credentials configured. "
                f"Set the Replit secret '{SERVICE_ACCOUNT_SECRET_KEY}' with your service account JSON key."
            )
            return

        try:
            self.credentials = json.loads(creds_json)
            self.service_account_email = self.credentials.get("client_email", "unknown")
            logger.info(f"Google service account loaded: {self.service_account_email}")
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse {SERVICE_ACCOUNT_SECRET_KEY}: {e}")
            self.credentials = None

    def _get_access_token(self) -> Optional[str]:
        if not self.credentials:
            logger.error("No Google credentials available")
            return None

        if self.access_token and time.time() < self.token_expiry - 60:
            return self.access_token

        try:
            jwt_token = self._create_signed_jwt()
            if not jwt_token:
                return None

            resp = requests.post("https://oauth2.googleapis.com/token", data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": jwt_token,
            }, timeout=30)
            resp.raise_for_status()
            token_data = resp.json()
            self.access_token = token_data["access_token"]
            self.token_expiry = int(time.time()) + token_data.get("expires_in", 3600)
            logger.info("Google access token refreshed successfully")
            return self.access_token
        except requests.exceptions.HTTPError as e:
            logger.error(f"Google token exchange failed (HTTP {e.response.status_code}): {e.response.text}")
            return None
        except Exception as e:
            logger.error(f"Failed to get Google access token: {e}")
            return None

    def _create_signed_jwt(self) -> Optional[str]:
        try:
            now = int(time.time())
            header = base64.urlsafe_b64encode(
                json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
            ).rstrip(b"=")
            payload_data = {
                "iss": self.credentials["client_email"],
                "scope": " ".join(SCOPES),
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
            }
            payload = base64.urlsafe_b64encode(
                json.dumps(payload_data).encode()
            ).rstrip(b"=")
            signing_input = header + b"." + payload

            with tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False) as kf:
                kf.write(self.credentials["private_key"])
                key_path = kf.name

            try:
                result = subprocess.run(
                    ["openssl", "dgst", "-sha256", "-sign", key_path],
                    input=signing_input,
                    capture_output=True,
                    timeout=10
                )
                if result.returncode != 0:
                    logger.error(f"OpenSSL signing failed: {result.stderr.decode()}")
                    return None
                signature = result.stdout
            finally:
                os.unlink(key_path)

            sig_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=")
            jwt_token = (signing_input + b"." + sig_b64).decode()
            return jwt_token
        except Exception as e:
            logger.error(f"JWT creation failed: {e}")
            return None

    def _headers(self) -> Dict:
        token = self._get_access_token()
        if not token:
            return {}
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _handle_api_error(self, e: Exception, api_name: str, operation: str, resource_id: str = ""):
        status_code = None
        error_body = ""
        if isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
            status_code = e.response.status_code
            error_body = e.response.text

        if status_code == 403:
            if "storageQuotaExceeded" in error_body:
                logger.warning(f"[{api_name}] Storage quota exceeded for {operation}.")
            elif "insufficientPermissions" in error_body or "forbidden" in error_body.lower():
                logger.error(
                    f"[{api_name}] Permission denied for {operation}. "
                    f"Scopes: {', '.join(SCOPES)}. "
                    f"Check that the target file/folder is shared with "
                    f"{self.service_account_email} as Editor."
                )
            else:
                logger.error(
                    f"[{api_name}] 403 Forbidden for {operation}: {error_body[:300]}. "
                    f"Verify the {api_name} API is enabled and "
                    f"{self.service_account_email} has Editor access."
                )
        elif status_code == 404:
            logger.error(
                f"[{api_name}] Resource not found for {operation} (ID: {resource_id}). "
                f"Check the file ID is correct and shared with {self.service_account_email}."
            )
        else:
            logger.error(f"[{api_name}] {operation} failed: {e}")

    def _is_quota_error(self, e: Exception) -> bool:
        if isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
            return e.response.status_code == 403 and "storageQuotaExceeded" in e.response.text
        return False

    def _find_existing_file(self, title: str, mime_type: str, folder_id: str = None) -> Optional[str]:
        headers = self._headers()
        if not headers:
            return None

        try:
            q_parts = [f"name = '{title}'", f"mimeType = '{mime_type}'", "trashed = false"]
            if folder_id:
                q_parts.append(f"'{folder_id}' in parents")
            q = " and ".join(q_parts)

            resp = requests.get(
                "https://www.googleapis.com/drive/v3/files",
                headers=headers,
                params={"q": q, "fields": "files(id,name)", "pageSize": 5},
                timeout=15
            )
            resp.raise_for_status()
            files = resp.json().get("files", [])
            if files:
                logger.info(f"Found existing file to reuse: '{title}' ({files[0]['id']})")
                return files[0]["id"]
        except Exception as e:
            logger.warning(f"Search for existing file '{title}' failed: {e}")

        return None

    def _clear_document(self, doc_id: str) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            get_resp = requests.get(
                f"https://docs.googleapis.com/v1/documents/{doc_id}",
                headers=headers, timeout=15
            )
            get_resp.raise_for_status()
            doc_data = get_resp.json()
            body_content = doc_data.get("body", {}).get("content", [])

            end_index = 1
            if body_content:
                end_index = body_content[-1].get("endIndex", 2) - 1
            if end_index <= 1:
                return True

            resp = requests.post(
                f"https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate",
                headers=headers,
                json={"requests": [{"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index}}}]},
                timeout=15
            )
            resp.raise_for_status()
            logger.info(f"Cleared document content: {doc_id}")
            return True
        except Exception as e:
            logger.warning(f"Failed to clear document {doc_id}: {e}")
            return False

    def _clear_spreadsheet(self, spreadsheet_id: str) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            resp = requests.get(
                f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}",
                headers=headers,
                params={"fields": "sheets.properties"},
                timeout=15
            )
            resp.raise_for_status()
            sheets = resp.json().get("sheets", [])

            batch_reqs = []
            for sheet in sheets:
                sheet_id = sheet["properties"]["sheetId"]
                if sheet_id == 0:
                    batch_reqs.append({
                        "updateCells": {
                            "range": {"sheetId": 0},
                            "fields": "userEnteredValue"
                        }
                    })
                else:
                    batch_reqs.append({"deleteSheet": {"sheetId": sheet_id}})

            if batch_reqs:
                resp2 = requests.post(
                    f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate",
                    headers=headers,
                    json={"requests": batch_reqs},
                    timeout=15
                )
                resp2.raise_for_status()

            logger.info(f"Cleared spreadsheet: {spreadsheet_id}")
            return True
        except Exception as e:
            logger.warning(f"Failed to clear spreadsheet {spreadsheet_id}: {e}")
            return False

    def _rename_file(self, file_id: str, new_title: str) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            resp = requests.patch(
                f"https://www.googleapis.com/drive/v3/files/{file_id}",
                headers=headers,
                json={"name": new_title},
                timeout=15
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"Failed to rename file {file_id}: {e}")
            return False

    def create_spreadsheet(self, title: str, folder_id: str = None) -> Optional[str]:
        headers = self._headers()
        if not headers:
            return None

        try:
            body = {
                "name": title,
                "mimeType": "application/vnd.google-apps.spreadsheet",
            }
            if folder_id:
                body["parents"] = [folder_id]
            resp = requests.post(
                "https://www.googleapis.com/drive/v3/files",
                headers=headers, json=body, timeout=30
            )
            resp.raise_for_status()
            spreadsheet_id = resp.json()["id"]
            logger.info(f"Created spreadsheet: {title} ({spreadsheet_id})")
            return spreadsheet_id
        except Exception as e:
            if self._is_quota_error(e):
                logger.info(f"Storage quota exceeded, searching for existing spreadsheet: {title}")
                existing_id = self._find_existing_file(
                    title, "application/vnd.google-apps.spreadsheet", folder_id
                )
                if existing_id:
                    self._clear_spreadsheet(existing_id)
                    return existing_id

                any_sheet = self._find_any_spreadsheet_in_folder(folder_id)
                if any_sheet:
                    logger.info(f"Reusing spreadsheet {any_sheet} and renaming to: {title}")
                    self._clear_spreadsheet(any_sheet)
                    self._rename_file(any_sheet, title)
                    return any_sheet

                logger.error(
                    f"Cannot create spreadsheet '{title}': service account has no storage quota. "
                    f"Create a Google Sheet named '{title}' in the leads folder and share it with "
                    f"{self.service_account_email} as Editor."
                )
            else:
                self._handle_api_error(e, "Drive", f"create_spreadsheet('{title}')")
            return None

    def _find_any_spreadsheet_in_folder(self, folder_id: str) -> Optional[str]:
        headers = self._headers()
        if not headers:
            return None

        try:
            if folder_id:
                resp = requests.get(
                    "https://www.googleapis.com/drive/v3/files",
                    headers=headers,
                    params={
                        "q": f"'{folder_id}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
                        "fields": "files(id,name)",
                        "pageSize": 10,
                    },
                    timeout=15
                )
                resp.raise_for_status()
                files = resp.json().get("files", [])
                if files:
                    return files[0]["id"]

            resp2 = requests.get(
                "https://www.googleapis.com/drive/v3/files",
                headers=headers,
                params={
                    "q": "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
                    "fields": "files(id,name)",
                    "pageSize": 10,
                },
                timeout=15
            )
            resp2.raise_for_status()
            all_sheets = resp2.json().get("files", [])
            if all_sheets:
                logger.info(f"Found accessible spreadsheet to reuse: {all_sheets[0]['name']} ({all_sheets[0]['id']})")
                return all_sheets[0]["id"]
        except Exception:
            pass
        return None

    def create_document(self, title: str, folder_id: str = None) -> Optional[str]:
        headers = self._headers()
        if not headers:
            return None

        try:
            body = {
                "name": title,
                "mimeType": "application/vnd.google-apps.document",
            }
            if folder_id:
                body["parents"] = [folder_id]
            resp = requests.post(
                "https://www.googleapis.com/drive/v3/files",
                headers=headers, json=body, timeout=30
            )
            resp.raise_for_status()
            doc_id = resp.json()["id"]
            logger.info(f"Created document: {title} ({doc_id})")
            return doc_id
        except Exception as e:
            if self._is_quota_error(e):
                logger.info(f"Storage quota exceeded, searching for existing document: {title}")
                existing_id = self._find_existing_file(
                    title, "application/vnd.google-apps.document", folder_id
                )
                if existing_id:
                    self._clear_document(existing_id)
                    return existing_id

                similar_id = self._find_similar_document(title, folder_id)
                if similar_id:
                    logger.info(f"Reusing document {similar_id} and renaming to: {title}")
                    self._clear_document(similar_id)
                    self._rename_file(similar_id, title)
                    return similar_id

                logger.error(
                    f"Cannot create document '{title}': service account has no storage quota. "
                    f"Create a Google Doc named '{title}' in the leads folder and share it with "
                    f"{self.service_account_email} as Editor."
                )
            else:
                self._handle_api_error(e, "Drive", f"create_document('{title}')")
            return None

    def _find_similar_document(self, title: str, folder_id: str = None) -> Optional[str]:
        if not folder_id:
            return None
        headers = self._headers()
        if not headers:
            return None

        try:
            town_names = ["Hartford", "East Hartford", "Windsor", "Berlin", "Rocky Hill"]
            target_town = None
            for t in town_names:
                if t.lower() in title.lower():
                    target_town = t
                    break

            q = f"'{folder_id}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false"
            if target_town and "Analysis" in title:
                q += f" and name contains '{target_town}' and name contains 'Analysis'"
            elif "LOGIC" in title:
                q += " and name contains 'LOGIC'"

            resp = requests.get(
                "https://www.googleapis.com/drive/v3/files",
                headers=headers,
                params={"q": q, "fields": "files(id,name)", "pageSize": 5},
                timeout=15
            )
            resp.raise_for_status()
            files = resp.json().get("files", [])
            if files:
                return files[0]["id"]
        except Exception:
            pass
        return None

    def append_rows(self, spreadsheet_id: str, sheet_name: str, rows: List[List]) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{sheet_name}:append"
            body = {"values": rows}
            resp = requests.post(
                url, headers=headers, json=body,
                params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
                timeout=30
            )
            resp.raise_for_status()
            logger.info(f"Appended {len(rows)} rows to {sheet_name}")
            return True
        except Exception as e:
            self._handle_api_error(e, "Sheets", f"append_rows to {spreadsheet_id}", spreadsheet_id)
            return False

    def read_sheet(self, spreadsheet_id: str, range_name: str) -> List[List]:
        headers = self._headers()
        if not headers:
            return []

        try:
            url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}"
            resp = requests.get(url, headers=headers, timeout=30)
            resp.raise_for_status()
            return resp.json().get("values", [])
        except Exception as e:
            self._handle_api_error(e, "Sheets", f"read_sheet {range_name}", spreadsheet_id)
            return []

    def write_document_content(self, doc_id: str, content: str) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            self._clear_document(doc_id)

            requests_body = [
                {
                    "insertText": {
                        "location": {"index": 1},
                        "text": content
                    }
                }
            ]
            resp = requests.post(
                f"https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate",
                headers=headers,
                json={"requests": requests_body},
                timeout=30
            )
            resp.raise_for_status()
            logger.info(f"Wrote content to document {doc_id}")
            return True
        except Exception as e:
            self._handle_api_error(e, "Docs", "write_document_content", doc_id)
            return False

    def append_document_content(self, doc_id: str, content: str) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            get_resp = requests.get(
                f"https://docs.googleapis.com/v1/documents/{doc_id}",
                headers=headers, timeout=30
            )
            get_resp.raise_for_status()
            doc_data = get_resp.json()
            body_content = doc_data.get("body", {}).get("content", [])
            end_index = 1
            if body_content:
                last_element = body_content[-1]
                end_index = last_element.get("endIndex", 1) - 1
            if end_index < 1:
                end_index = 1

            requests_body = [
                {
                    "insertText": {
                        "location": {"index": end_index},
                        "text": content
                    }
                }
            ]
            resp = requests.post(
                f"https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate",
                headers=headers,
                json={"requests": requests_body},
                timeout=30
            )
            resp.raise_for_status()
            logger.info(f"Appended content to document {doc_id}")
            return True
        except Exception as e:
            self._handle_api_error(e, "Docs", "append_document_content", doc_id)
            return False

    def copy_document(self, template_doc_id: str, new_title: str, folder_id: str = None) -> Optional[str]:
        headers = self._headers()
        if not headers:
            return None

        try:
            body = {"name": new_title}
            if folder_id:
                body["parents"] = [folder_id]

            resp = requests.post(
                f"https://www.googleapis.com/drive/v3/files/{template_doc_id}/copy",
                headers=headers, json=body, timeout=30
            )
            resp.raise_for_status()
            new_id = resp.json()["id"]
            logger.info(f"Copied template to: {new_title} ({new_id})")
            return new_id
        except Exception as e:
            if self._is_quota_error(e):
                logger.info(f"Storage quota exceeded for copy, creating empty doc instead: {new_title}")
                return self.create_document(new_title, folder_id)
            self._handle_api_error(e, "Drive", f"copy_document('{new_title}')", template_doc_id)
            return None

    def replace_text_in_doc(self, doc_id: str, replacements: Dict[str, str]) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            reqs = []
            for placeholder, value in replacements.items():
                reqs.append({
                    "replaceAllText": {
                        "containsText": {"text": placeholder, "matchCase": True},
                        "replaceText": str(value)
                    }
                })

            resp = requests.post(
                f"https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate",
                headers=headers,
                json={"requests": reqs},
                timeout=30
            )
            resp.raise_for_status()
            logger.info(f"Replaced {len(replacements)} fields in doc {doc_id}")
            return True
        except Exception as e:
            self._handle_api_error(e, "Docs", "replace_text_in_doc", doc_id)
            return False

    def _move_to_folder(self, file_id: str, folder_id: str) -> bool:
        headers = self._headers()
        if not headers:
            return False

        try:
            get_resp = requests.get(
                f"https://www.googleapis.com/drive/v3/files/{file_id}",
                headers=headers, params={"fields": "parents"}, timeout=30
            )
            get_resp.raise_for_status()
            current_parents = ",".join(get_resp.json().get("parents", []))

            resp = requests.patch(
                f"https://www.googleapis.com/drive/v3/files/{file_id}",
                headers=headers,
                params={"addParents": folder_id, "removeParents": current_parents},
                timeout=30
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            self._handle_api_error(e, "Drive", "move_to_folder", file_id)
            return False

    def test_connection(self) -> Dict[str, Any]:
        results = {
            "auth": False,
            "drive_read": False,
            "sheets_write": False,
            "docs_write": False,
            "service_account": self.service_account_email,
            "errors": [],
        }

        token = self._get_access_token()
        if not token:
            results["errors"].append("Failed to obtain access token")
            return results
        results["auth"] = True

        headers = self._headers()
        try:
            resp = requests.get(
                "https://www.googleapis.com/drive/v3/about",
                headers=headers, params={"fields": "user,storageQuota"}, timeout=15
            )
            resp.raise_for_status()
            data = resp.json()
            results["drive_read"] = True
            results["drive_user"] = data.get("user", {}).get("emailAddress", "unknown")
            quota = data.get("storageQuota", {})
            results["storage_limit"] = quota.get("limit", "0")
            if str(quota.get("limit", "0")) == "0":
                results["errors"].append(
                    "Service account has 0 storage quota. Files must be pre-created by a regular "
                    "Google account and shared with the service account. The bot will find and reuse "
                    "existing files automatically."
                )
        except Exception as e:
            results["errors"].append(f"Drive API: {e}")

        sheet_id = "1mxQKY-AgXPXoJyFJBJHFUat-PwxYXzy4XVqqGZPPn0o"
        try:
            data = self.read_sheet(sheet_id, "Sheet1!A1:A1")
            if data is not None:
                results["sheets_write"] = True
        except Exception as e:
            results["errors"].append(f"Sheets API: {e}")

        try:
            folder_id = "128JqjJpDrSkV9ZyylFIICT-MJK5tBxOg"
            resp2 = requests.get(
                "https://www.googleapis.com/drive/v3/files",
                headers=headers,
                params={
                    "q": f"'{folder_id}' in parents and mimeType='application/vnd.google-apps.document'",
                    "fields": "files(id,name)", "pageSize": 1,
                },
                timeout=15
            )
            resp2.raise_for_status()
            docs = resp2.json().get("files", [])
            if docs:
                get_resp = requests.get(
                    f"https://docs.googleapis.com/v1/documents/{docs[0]['id']}",
                    headers=headers, timeout=15
                )
                if get_resp.status_code == 200:
                    results["docs_write"] = True
        except Exception as e:
            results["errors"].append(f"Docs API: {e}")

        return results


_client = None

def get_google_client() -> GoogleClient:
    global _client
    if _client is None:
        _client = GoogleClient()
    return _client


logger.info("Google client module loaded (service account auth with openssl JWT signing)")
