import os
import re
import json
import logging
import requests
import time
import random
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from urllib.parse import urlencode, quote

logger = logging.getLogger(__name__)

CT_COURT_URL = "https://civilinquiry.jud.ct.gov"

SCRAPERAPI_BASE = "http://api.scraperapi.com"


class SearchIQSScraper:
    MAX_LOGIN_RETRIES = 3
    RETRY_BACKOFF = [5, 15, 30]

    def __init__(self, base_url: str = "https://www.searchiqs.com/CTEHART", town_name: str = "Hartford"):
        self.base_url = base_url.rstrip("/")
        self.town_name = town_name
        self.search_url = f"{self.base_url}/SearchAdvancedMP.aspx"
        self.results_url = f"{self.base_url}/SearchResultsMP.aspx"
        self.login_url = f"{self.base_url}/"
        self.session = requests.Session()
        self._browser_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Cache-Control": "max-age=0",
        }
        self.session.headers.update(self._browser_headers)
        self.logged_in = False
        self.login_page_html = None

        self.scraper_api_key = os.environ.get("SCRAPER_API_KEY", "").strip()
        self.use_proxy = bool(self.scraper_api_key)
        self._session_number = str(random.randint(100000, 999999))
        if self.use_proxy:
            logger.info(f"[{self.town_name}] ScraperAPI proxy ENABLED (session={self._session_number})")
        else:
            logger.info(f"[{self.town_name}] ScraperAPI proxy not configured, using direct requests")

    def _proxy_get(self, url, timeout=60):
        params = {
            "api_key": self.scraper_api_key,
            "url": url,
            "session_number": self._session_number,
            "country_code": "us",
            "follow_redirect": "true",
            "keep_headers": "true",
        }
        logger.debug(f"[{self.town_name}] ScraperAPI GET: {url}")
        resp = requests.get(SCRAPERAPI_BASE, params=params, timeout=timeout, headers=self._browser_headers)
        return resp

    def _proxy_post(self, url, data, timeout=60):
        params = {
            "api_key": self.scraper_api_key,
            "url": url,
            "session_number": self._session_number,
            "country_code": "us",
            "follow_redirect": "true",
            "keep_headers": "true",
        }
        headers = dict(self._browser_headers)
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        logger.debug(f"[{self.town_name}] ScraperAPI POST: {url}")
        resp = requests.post(SCRAPERAPI_BASE, params=params, data=data, timeout=timeout, headers=headers)
        return resp

    def _do_get(self, url, timeout=30):
        if self.use_proxy:
            return self._proxy_get(url, timeout=max(timeout, 60))
        return self.session.get(url, timeout=timeout)

    def _do_post(self, url, data, timeout=30):
        if self.use_proxy:
            return self._proxy_post(url, data, timeout=max(timeout, 60))
        return self.session.post(url, data=data, timeout=timeout, allow_redirects=True)

    def _get_with_retry(self, url, max_retries=None, timeout=30):
        retries = max_retries or self.MAX_LOGIN_RETRIES
        for attempt in range(retries):
            try:
                resp = self._do_get(url, timeout=timeout)
                if resp.status_code == 403:
                    wait = self.RETRY_BACKOFF[min(attempt, len(self.RETRY_BACKOFF) - 1)]
                    logger.warning(f"[{self.town_name}] 403 on GET {url} (attempt {attempt+1}/{retries}), retrying in {wait}s...")
                    time.sleep(wait)
                    continue
                if resp.status_code == 503:
                    wait = self.RETRY_BACKOFF[min(attempt, len(self.RETRY_BACKOFF) - 1)]
                    logger.warning(f"[{self.town_name}] 503 maintenance on {url} (attempt {attempt+1}/{retries}), retrying in {wait}s...")
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                return resp
            except requests.exceptions.HTTPError:
                if attempt < retries - 1:
                    wait = self.RETRY_BACKOFF[min(attempt, len(self.RETRY_BACKOFF) - 1)]
                    logger.warning(f"[{self.town_name}] HTTP error on {url} (attempt {attempt+1}), retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise
            except requests.exceptions.ConnectionError:
                if attempt < retries - 1:
                    wait = self.RETRY_BACKOFF[min(attempt, len(self.RETRY_BACKOFF) - 1)]
                    logger.warning(f"[{self.town_name}] Connection error on {url} (attempt {attempt+1}), retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise
        raise requests.exceptions.HTTPError(f"Failed after {retries} retries: {url}")

    def login_as_guest(self) -> bool:
        try:
            logger.info(f"Logging into SearchIQS as guest ({self.town_name})... [proxy={'ON' if self.use_proxy else 'OFF'}]")
            resp = self._get_with_retry(self.login_url)

            if len(resp.text) < 100:
                logger.warning(f"Empty page from {self.login_url}, retrying...")
                time.sleep(2)
                resp = self._get_with_retry(self.login_url)

            if "btnGuestLogin" not in resp.text and "Search Records as Guest" not in resp.text:
                logger.warning(f"[{self.town_name}] Guest login button not found — site may be in maintenance mode (page length: {len(resp.text)})")
                return False

            viewstate = self._extract_field(resp.text, "__VIEWSTATE")
            viewstategenerator = self._extract_field(resp.text, "__VIEWSTATEGENERATOR")
            eventvalidation = self._extract_field(resp.text, "__EVENTVALIDATION")

            login_data = {
                "__EVENTTARGET": "btnGuestLogin",
                "__EVENTARGUMENT": "",
                "__VIEWSTATE": viewstate,
                "__VIEWSTATEGENERATOR": viewstategenerator,
                "__EVENTVALIDATION": eventvalidation,
                "BrowserWidth": "1920",
                "BrowserHeight": "1080",
                "hidPendingID": "",
                "username": "",
                "password": "",
            }

            if not self.use_proxy:
                self.session.headers["Sec-Fetch-Site"] = "same-origin"
                self.session.headers["Referer"] = self.login_url
            resp2 = self._do_post(self.login_url, data=login_data, timeout=30)

            if resp2.status_code == 200 and ("SearchAdvanced" in resp2.url or "Search" in resp2.text):
                self.logged_in = True
                self.login_page_html = resp2.text
                logger.info(f"SearchIQS guest login successful ({self.town_name}) -> {resp2.url}")
                return True
            elif resp2.status_code == 200 and ("Search" in resp2.text or "cboDocType" in resp2.text or "ContentPlaceHolder1" in resp2.text):
                self.logged_in = True
                self.login_page_html = resp2.text
                logger.info(f"SearchIQS guest login successful ({self.town_name}) [proxy mode, detected search form in response]")
                return True
            else:
                logger.warning(f"SearchIQS login may have failed for {self.town_name} (status: {resp2.status_code}, url: {resp2.url}, body_len: {len(resp2.text)})")
                return False
        except Exception as e:
            logger.error(f"SearchIQS login failed for {self.town_name}: {e}")
            return False

    def _needs_docgroup_postback(self) -> bool:
        return "CTHAR" in self.base_url

    def _do_docgroup_postback(self, form_html: str) -> str:
        logger.info(f"[{self.town_name}] Performing DocGroup postback to 'LR' (Land Records)")
        viewstate = self._extract_field(form_html, "__VIEWSTATE")
        viewstategenerator = self._extract_field(form_html, "__VIEWSTATEGENERATOR")
        eventvalidation = self._extract_field(form_html, "__EVENTVALIDATION")

        hidden_fields = re.findall(
            r'<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"',
            form_html
        )

        postback_data = {
            "__EVENTTARGET": "ctl00$ContentPlaceHolder1$cboDocGroup",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "__VIEWSTATE": viewstate,
            "__VIEWSTATEGENERATOR": viewstategenerator,
            "__EVENTVALIDATION": eventvalidation,
            "ctl00$ContentPlaceHolder1$scrollPos": "0",
            "ctl00$ContentPlaceHolder1$cboDocGroup": "LR",
            "ctl00$ContentPlaceHolder1$cboDocType": "(ALL)",
            "ctl00$ContentPlaceHolder1$txtName": "",
            "ctl00$ContentPlaceHolder1$txtFirstName": "",
            "ctl00$ContentPlaceHolder1$chkIgnorePartyType": "on",
            "ctl00$ContentPlaceHolder1$txtParty2Name": "",
            "ctl00$ContentPlaceHolder1$txtParty2FirstName": "",
            "ctl00$ContentPlaceHolder1$txtFromDate": "",
            "ctl00$ContentPlaceHolder1$txtThruDate": "",
            "ctl00$ContentPlaceHolder1$txtBook": "",
            "ctl00$ContentPlaceHolder1$txtPage": "",
            "ctl00$ContentPlaceHolder1$txtUDFNum": "",
            "ctl00$ContentPlaceHolder1$txtExtraField1": "",
            "BrowserWidth": "1920",
            "BrowserHeight": "1080",
        }

        for name, val in hidden_fields:
            if name not in postback_data and not name.startswith("__"):
                postback_data[name] = val

        if not self.use_proxy:
            self.session.headers["Referer"] = self.search_url
            self.session.headers["Content-Type"] = "application/x-www-form-urlencoded"

        time.sleep(2)
        resp = self._do_post(self.search_url, data=postback_data, timeout=30)
        resp.raise_for_status()
        logger.info(f"[{self.town_name}] DocGroup postback complete, page length: {len(resp.text)}")
        return resp.text

    def search_lis_pendens(self, days_back: int = 30, fetch_details: bool = True) -> List[Dict]:
        if not self.logged_in:
            if not self.login_as_guest():
                raise RuntimeError(f"SearchIQS login failed for {self.town_name} — site may be in maintenance or blocking requests")

        end_date = datetime.now()
        start_date = end_date - timedelta(days=days_back)
        date_from = start_date.strftime("%m/%d/%Y")
        date_to = end_date.strftime("%m/%d/%Y")

        logger.info(f"Searching Lis Pendens in {self.town_name} from {date_from} to {date_to}")

        try:
            form_html = self.login_page_html
            if not form_html:
                resp = self._do_get(self.search_url, timeout=30)
                resp.raise_for_status()
                form_html = resp.text

            doc_group = "(ALL)"
            if self._needs_docgroup_postback():
                form_html = self._do_docgroup_postback(form_html)
                doc_group = "LR"

            viewstate = self._extract_field(form_html, "__VIEWSTATE")
            viewstategenerator = self._extract_field(form_html, "__VIEWSTATEGENERATOR")
            eventvalidation = self._extract_field(form_html, "__EVENTVALIDATION")

            hidden_fields = re.findall(
                r'<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"',
                form_html
            )

            search_data = {
                "__EVENTTARGET": "",
                "__EVENTARGUMENT": "",
                "__LASTFOCUS": "",
                "__VIEWSTATE": viewstate,
                "__VIEWSTATEGENERATOR": viewstategenerator,
                "__EVENTVALIDATION": eventvalidation,
                "ctl00$ContentPlaceHolder1$scrollPos": "0",
                "ctl00$ContentPlaceHolder1$cboDocGroup": doc_group,
                "ctl00$ContentPlaceHolder1$cboDocType": "LIS PENDENS",
                "ctl00$ContentPlaceHolder1$txtName": "",
                "ctl00$ContentPlaceHolder1$txtFirstName": "",
                "ctl00$ContentPlaceHolder1$chkIgnorePartyType": "on",
                "ctl00$ContentPlaceHolder1$txtParty2Name": "",
                "ctl00$ContentPlaceHolder1$txtParty2FirstName": "",
                "ctl00$ContentPlaceHolder1$txtFromDate": date_from,
                "ctl00$ContentPlaceHolder1$txtThruDate": date_to,
                "ctl00$ContentPlaceHolder1$txtBook": "",
                "ctl00$ContentPlaceHolder1$txtPage": "",
                "ctl00$ContentPlaceHolder1$txtUDFNum": "",
                "ctl00$ContentPlaceHolder1$cmdSearch": "Search",
                "BrowserWidth": "1920",
                "BrowserHeight": "1080",
            }

            if "cboTown" in form_html:
                search_data["ctl00$ContentPlaceHolder1$cboTown"] = "(ALL)"
            if "txtExtraField1" in form_html:
                search_data["ctl00$ContentPlaceHolder1$txtExtraField1"] = ""
            if "txtCaseNum" in form_html:
                search_data["ctl00$ContentPlaceHolder1$txtCaseNum"] = ""

            for name, val in hidden_fields:
                if name not in search_data and not name.startswith("__"):
                    search_data[name] = val

            if not self.use_proxy:
                self.session.headers["Referer"] = self.search_url
                self.session.headers["Content-Type"] = "application/x-www-form-urlencoded"

            time.sleep(3)

            resp2 = self._do_post(self.search_url, data=search_data, timeout=60)
            self.login_page_html = None
            resp2.raise_for_status()

            logger.info(f"[{self.town_name}] Search response URL: {resp2.url}, length: {len(resp2.text)}")

            results = self._parse_search_results(resp2.text)
            logger.info(f"Found {len(results)} Lis Pendens filings in {self.town_name}")

            for result in results:
                result["town"] = self.town_name

            if fetch_details and results:
                for i, result in enumerate(results):
                    view_btn = result.get("view_button_name", "")
                    if view_btn and "SearchResults" in resp2.url:
                        try:
                            details = self._fetch_document_via_button(resp2, view_btn, i)
                            if details:
                                result.update(details)
                                logger.info(f"[{self.town_name}] Fetched details for filing {i+1}/{len(results)}: {result.get('property_address', 'N/A')}")
                        except Exception as e:
                            logger.warning(f"[{self.town_name}] Failed to fetch details for filing {i+1}: {e}")
                        time.sleep(1.5)

            return results

        except Exception as e:
            logger.error(f"SearchIQS search failed for {self.town_name}: {e}")
            return []

    def _parse_search_results(self, html: str) -> List[Dict]:
        results = []
        tag_cleaner = re.compile(r'<[^>]+>')

        doc_count_match = re.search(r'A total of (\d+) document', html, re.IGNORECASE)
        total_docs = int(doc_count_match.group(1)) if doc_count_match else 0
        logger.info(f"[{self.town_name}] Page reports {total_docs} documents")

        if total_docs == 0:
            if "No records found" in html or "0 document" in html:
                logger.info(f"[{self.town_name}] No records found on search results page")
            return results

        table_match = re.search(
            r'<table[^>]*id=["\']ContentPlaceHolder1_grdResults["\'][^>]*>(.*?)</table>',
            html, re.DOTALL | re.IGNORECASE
        )

        if not table_match:
            table_match = re.search(
                r'<table[^>]*id=["\'][^"\']*(?:Results|Grid)["\'][^>]*>(.*?)</table>',
                html, re.DOTALL | re.IGNORECASE
            )

        if table_match:
            table_html = table_match.group(1)
            rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL)

            header_row = None
            data_rows = []
            for row in rows:
                cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
                cleaned = [tag_cleaner.sub(' ', c).strip() for c in cells]
                cleaned = [re.sub(r'\s+', ' ', c).strip() for c in cleaned]

                if any(h in ' '.join(cleaned).upper() for h in ['PARTY 1', 'PARTY 2', 'TYPE', 'BOOK-PAGE', 'DATE']):
                    header_row = cleaned
                    continue

                if len(cleaned) >= 5 and any('LIS' in c.upper() for c in cleaned):
                    data_rows.append((row, cleaned))

            for raw_row, cleaned in data_rows:
                view_btn_match = re.search(
                    r'name=["\']([^"\']*btnView[^"\']*)["\']',
                    raw_row, re.IGNORECASE
                )
                view_button_name = view_btn_match.group(1) if view_btn_match else ""

                record_id = ""
                party1 = ""
                party2 = ""
                doc_type = ""
                book_page = ""
                rec_date = ""
                prop_desc = ""
                description = ""

                col_idx = 0
                for cell_val in cleaned:
                    if not cell_val or cell_val == '&nbsp;':
                        col_idx += 1
                        continue

                    if re.match(r'^View\*?$', cell_val, re.IGNORECASE):
                        col_idx += 1
                        continue

                    if re.match(r'^L\|\d+$', cell_val):
                        record_id = cell_val
                    elif 'LIS PENDENS' in cell_val.upper():
                        doc_type = cell_val
                    elif re.match(r'^\d{1,2}/\d{1,2}/\d{4}$', cell_val):
                        rec_date = cell_val
                    elif re.match(r'^\d{2,5}-\d+$', cell_val):
                        book_page = cell_val
                    elif re.match(r'^BK:', cell_val, re.IGNORECASE):
                        description = cell_val
                    elif not party1 and len(cell_val) > 3 and not cell_val.isdigit():
                        party1 = cell_val
                    elif party1 and not party2 and len(cell_val) > 2 and cell_val != party1:
                        if not re.match(r'^\d{2,5}-\d+$', cell_val):
                            party2 = cell_val

                    col_idx += 1

                if header_row and len(cleaned) == len(header_row):
                    for hi, header in enumerate(header_row):
                        hu = header.upper().strip()
                        if hi < len(cleaned):
                            val = cleaned[hi]
                            if 'PARTY 1' in hu and val:
                                party1 = val
                            elif 'PARTY 2' in hu and val:
                                party2 = val
                            elif hu == 'TYPE' and val:
                                doc_type = val
                            elif 'BOOK' in hu and val:
                                book_page = val
                            elif hu == 'DATE' and val:
                                rec_date = val
                            elif 'PROPERTY' in hu and val:
                                prop_desc = val
                            elif 'DESCRIPTION' in hu and val:
                                description = val

                if not prop_desc:
                    for cell_val in cleaned:
                        if cell_val and len(cell_val) > 5 and cell_val != party1 and cell_val != party2:
                            if 'PIECE' in cell_val.upper() or 'LOT' in cell_val.upper() or 'RD' in cell_val.upper() or 'ST' in cell_val.upper() or 'AVE' in cell_val.upper() or 'HILL' in cell_val.upper():
                                prop_desc = cell_val
                                break

                result = {
                    "record_id": record_id,
                    "party1_seller": party1,
                    "party2_lender": party2,
                    "doc_type": doc_type or "LIS PENDENS",
                    "book_page": book_page,
                    "recording_date": rec_date,
                    "status": "PENDING",
                    "property_description": prop_desc,
                    "additional_description": description,
                    "view_button_name": view_button_name,
                    "view_url": "",
                    "searchiqs_url": "",
                    "property_address": prop_desc if prop_desc and "SEE DEED" not in prop_desc.upper() else "",
                    "seller": party1,
                    "lender": party2,
                    "original_mortgage": description,
                    "court_case_number": "",
                    "debt_amount": "",
                    "return_date": "",
                    "plaintiff": party2,
                    "defendant": party1,
                    "parties": f"{party1} vs {party2}" if party1 and party2 else party1 or party2,
                    "town": self.town_name,
                }
                results.append(result)

        if not results and total_docs > 0:
            logger.info(f"[{self.town_name}] Table parse missed {total_docs} docs, trying text-based fallback...")
            text_blocks = re.findall(r'LIS\s+PENDENS.*?(?=LIS\s+PENDENS|Selection Criteria|$)', html, re.DOTALL | re.IGNORECASE)
            for block in text_blocks[:20]:
                clean_block = tag_cleaner.sub(' ', block)
                clean_block = re.sub(r'\s+', ' ', clean_block).strip()

                date_match = re.search(r'(\d{1,2}/\d{1,2}/\d{4})', clean_block)
                bp_match = re.search(r'(\d{2,5}-\d+)', clean_block)
                prop_match = re.search(r'((?:TWO|THREE|ONE|FOUR|FIVE)?\s*PIECES?\s*[-–]\s*\w[\w\s]+(?:RD|ST|AVE|DR|LN|BLVD|WAY|CT|PL))', clean_block, re.IGNORECASE)

                result = {
                    "recording_date": date_match.group(1) if date_match else "",
                    "doc_type": "LIS PENDENS",
                    "book_page": bp_match.group(1) if bp_match else "",
                    "parties": clean_block[:200],
                    "plaintiff": "",
                    "defendant": "",
                    "seller": "",
                    "lender": "",
                    "property_address": prop_match.group(1).strip() if prop_match else "",
                    "property_description": prop_match.group(1).strip() if prop_match else "",
                    "view_url": "",
                    "view_button_name": "",
                    "searchiqs_url": "",
                    "court_case_number": "",
                    "debt_amount": "",
                    "return_date": "",
                    "status": "PENDING",
                    "original_mortgage": "",
                    "additional_description": "",
                    "party1_seller": "",
                    "party2_lender": "",
                    "record_id": "",
                    "town": self.town_name,
                }
                results.append(result)

        return results

    def _fetch_document_via_button(self, results_resp, button_name: str, idx: int) -> Optional[Dict]:
        try:
            viewstate = self._extract_field(results_resp.text, "__VIEWSTATE")
            vsg = self._extract_field(results_resp.text, "__VIEWSTATEGENERATOR")
            ev = self._extract_field(results_resp.text, "__EVENTVALIDATION")

            post_data = {
                "__EVENTTARGET": "",
                "__EVENTARGUMENT": "",
                "__VIEWSTATE": viewstate,
                "__VIEWSTATEGENERATOR": vsg,
                "__EVENTVALIDATION": ev,
                button_name: "View*",
                "BrowserWidth": "1920",
                "BrowserHeight": "1080",
            }

            resp = self._do_post(self.results_url, data=post_data, timeout=30)
            if resp.status_code != 200:
                return None

            return self._parse_document_page(resp.text)

        except Exception as e:
            logger.warning(f"[{self.town_name}] Document button fetch failed: {e}")
            return None

    def _fetch_document_details(self, view_url: str) -> Optional[Dict]:
        try:
            resp = self._do_get(view_url, timeout=30)
            if resp.status_code != 200:
                return None
            return self._parse_document_page(resp.text)
        except Exception as e:
            logger.warning(f"[{self.town_name}] Document detail fetch failed for {view_url}: {e}")
            return None

    def _parse_document_page(self, html: str) -> Optional[Dict]:
        details = {}

        instr_match = re.search(r'Instr\s*#?:?\s*(\d{4}-\d+)', html)
        if instr_match:
            details["instrument_number"] = instr_match.group(1)

        bp_match = re.search(r'Book/Page:?\s*(\d+\s*/?\s*\d+)', html)
        if bp_match:
            details["book_page_detail"] = bp_match.group(1).strip()

        rec_match = re.search(r'Rec\s*Date:?\s*(\d{1,2}/\d{1,2}/\d{4})', html)
        if rec_match:
            details["recording_date_detail"] = rec_match.group(1)

        or_party_match = re.search(r'OR\s*Party:?\s*(.*?)(?=EE\s*Party|Description|$)', html, re.DOTALL | re.IGNORECASE)
        if or_party_match:
            or_text = re.sub(r'<[^>]+>', '\n', or_party_match.group(1))
            or_names = [n.strip() for n in or_text.strip().split('\n') if n.strip() and len(n.strip()) > 2]
            details["or_parties"] = or_names
            if or_names:
                details["seller"] = or_names[0]

        ee_party_match = re.search(r'EE\s*Party:?\s*(.*?)(?=Description|Property|$)', html, re.DOTALL | re.IGNORECASE)
        if ee_party_match:
            ee_text = re.sub(r'<[^>]+>', '\n', ee_party_match.group(1))
            ee_names = [n.strip() for n in ee_text.strip().split('\n') if n.strip() and len(n.strip()) > 2]
            details["ee_parties"] = ee_names
            if ee_names:
                details["lender"] = ee_names[0]

        desc_match = re.search(r'Description:?\s*([^\n<]+)', html)
        if desc_match:
            details["description"] = desc_match.group(1).strip()

        prop_match = re.search(r'Property\s*Description:?\s*([^\n<]+)', html)
        if prop_match:
            details["property_description_detail"] = prop_match.group(1).strip()

        return_match = re.search(r'Return\s*Name/Address:?\s*([^\n<]+)', html)
        if return_match:
            details["return_name_address"] = return_match.group(1).strip()

        clean_text = re.sub(r'<[^>]+>', ' ', html)
        clean_text = re.sub(r'\s+', ' ', clean_text)

        return_date_match = re.search(
            r'(?:RETURN\s*DATE|returnable|made\s+returnable)\s*:?\s*(\w+\s+\d{1,2},?\s+\d{4})',
            clean_text, re.IGNORECASE
        )
        if return_date_match:
            details["return_date"] = return_date_match.group(1).strip()

        file_match = re.search(r'File:?\s*([\d-]+\w*CT)', clean_text, re.IGNORECASE)
        if not file_match:
            file_match = re.search(r'(HHD-CV[\d-]+\w*)', clean_text, re.IGNORECASE)
        if not file_match:
            file_match = re.search(r'(\d{2,4}-\d{4,6}\s*CT)', clean_text, re.IGNORECASE)
        if file_match:
            details["court_case_number"] = file_match.group(1).strip()

        addr_match = re.search(
            r'(?:known\s+as|located\s+at|property\s+address[:\s]+)\s*(\d+[\w\s\-,]+(?:Street|Avenue|Road|Drive|Lane|Court|Place|Terrace|Boulevard|Way|Circle|Blvd|Ave|Rd|Dr|Ln|Ct|Pl|Pkwy)(?:\s*,?\s*(?:aka|also\s+known)\s+[\w\s\-,]+)?)',
            clean_text, re.IGNORECASE
        )
        if addr_match:
            address = addr_match.group(1).strip()
            address = re.sub(r'\s*,?\s*(?:in\s+the|City|County|Hartford|Connecticut|Town).*$', '', address, flags=re.IGNORECASE)
            details["property_address"] = address.strip().rstrip(',')

        mortgage_match = re.search(
            r'(?:mortgage\s+was\s+dated|recorded)\s+.*?(?:in\s+)?Volume\s+(\d+)\s+(?:at\s+)?Page\s+(\d+)',
            clean_text, re.IGNORECASE
        )
        if mortgage_match:
            details["original_mortgage"] = f"VOL {mortgage_match.group(1)} PAGE {mortgage_match.group(2)}"

        vol_match = re.search(r'(VOL\.?\s*\d+\s*(?:PAGE|PG)\.?\s*\d+)', clean_text, re.IGNORECASE)
        if vol_match and "original_mortgage" not in details:
            details["original_mortgage"] = vol_match.group(1).strip()

        v_match = re.search(
            r'([\w\s,\.]+(?:TRUST|LLC|ASSOCIATION|BANK|CORP|INC|COMPANY)[\w\s,\.]*)\s*V\.?\s+([\w\s,\.]+?)(?:\s*[:,]|\s+DECEMBER|\s+JANUARY|\s+FEBRUARY|\s+MARCH|\s+APRIL|\s+MAY|\s+JUNE|\s+JULY|\s+AUGUST|\s+SEPTEMBER|\s+OCTOBER|\s+NOVEMBER)',
            clean_text, re.IGNORECASE
        )
        if v_match:
            if "plaintiff_full" not in details:
                details["plaintiff_full"] = v_match.group(1).strip()
            if "defendant_full" not in details:
                defendant_text = v_match.group(2).strip()
                defendant_text = re.sub(r',?\s*ET\s*AL\.?', '', defendant_text, flags=re.IGNORECASE).strip()
                details["defendant_full"] = defendant_text

        attorney_match = re.search(
            r'(?:By|Plaintiff):\s*\n?\s*([\w\s\.]+,?\s*Esq\.?)\s*\n?\s*([\w\s,\.]+(?:LLP|LLC|P\.?C\.?|PA|PLLC))',
            clean_text, re.IGNORECASE
        )
        if attorney_match:
            details["attorney"] = attorney_match.group(1).strip()
            details["attorney_firm"] = attorney_match.group(2).strip()

        related_links = re.findall(r'href=["\']([^"\']*)["\'][^>]*>\s*(\d{1,2}/\d{1,2}/\d{4}\s+MORTGAGE[^<]*)', html, re.IGNORECASE)
        if related_links:
            details["related_documents"] = [{"url": l[0], "description": l[1].strip()} for l in related_links]

        return details if details else None

    def search_court_case(self, party_name: str) -> Optional[Dict]:
        try:
            search_url = f"{CT_COURT_URL}/CaseSearch"
            resp = self.session.get(search_url, params={
                "partyName": party_name,
                "caseType": "FC",
            }, timeout=30)

            if resp.status_code == 200:
                case_match = re.search(r'(HHD-CV\d{2}-\d+)', resp.text)
                if not case_match:
                    case_match = re.search(r'(\d{2,4}-\d{4,6}\s*CT)', resp.text, re.IGNORECASE)
                debt_match = re.search(r'\$[\d,]+\.?\d*', resp.text)
                date_match = re.search(r'Return Date:?\s*(\d{1,2}/\d{1,2}/\d{4})', resp.text)
                status_match = re.search(r'Status:?\s*([A-Za-z\s]+)', resp.text)

                return {
                    "case_number": case_match.group(1) if case_match else "Not found",
                    "debt_amount": debt_match.group(0) if debt_match else "Unknown",
                    "return_date": date_match.group(1) if date_match else "TBD",
                    "status": status_match.group(1).strip() if status_match else "Pending",
                    "court_url": f"{CT_COURT_URL}/CaseDetail.aspx?DocketNo={case_match.group(1)}" if case_match else "",
                }

            return None
        except Exception as e:
            logger.warning(f"Court case search failed for {party_name}: {e}")
            return None

    def _extract_field(self, html: str, field_name: str) -> str:
        pattern = rf'id="{field_name}"[^>]*value="([^"]*)"'
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return match.group(1)
        pattern2 = rf'name="{field_name}"[^>]*value="([^"]*)"'
        match2 = re.search(pattern2, html, re.IGNORECASE)
        return match2.group(1) if match2 else ""

    def _extract_hidden(self, html: str, field_name: str) -> str:
        escaped = field_name.replace("$", r"\$")
        pattern = rf'name="{escaped}"[^>]*value="([^"]*)"'
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return match.group(1)
        field_id = field_name.replace("$", "_")
        return self._extract_field(html, field_id)

    def get_filing_as_row(self, filing: Dict) -> List[str]:
        return [
            filing.get("town", ""),
            filing.get("property_address", "") or filing.get("property_description", "SEE DEED"),
            filing.get("seller", "") or filing.get("party1_seller", ""),
            filing.get("lender", "") or filing.get("party2_lender", ""),
            filing.get("recording_date", "") or filing.get("recording_date_detail", ""),
            filing.get("original_mortgage", "") or filing.get("additional_description", ""),
            filing.get("court_case_number", ""),
            filing.get("debt_amount", ""),
            filing.get("return_date", ""),
            filing.get("status", "PENDING"),
        ]


def create_scraper(base_url: str, town_name: str) -> SearchIQSScraper:
    return SearchIQSScraper(base_url=base_url, town_name=town_name)


_scraper = None

def get_scraper() -> SearchIQSScraper:
    global _scraper
    if _scraper is None:
        _scraper = SearchIQSScraper()
    return _scraper


logger.info("SearchIQS scraper module loaded (v4 - fixed login & search)")
