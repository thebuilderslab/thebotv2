import os
import json
import logging
import time
import requests
from datetime import datetime, timedelta
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    from zoneinfo import ZoneInfo
    EASTERN = ZoneInfo('America/New_York')
except ImportError:
    from datetime import timezone
    EASTERN = timezone(timedelta(hours=-5))

from config import REAL_ESTATE_CONFIG, PERPLEXITY_CONFIG
from perplexity_client import (
    perplexity_chat,
    generate_case_law_summary,
    generate_property_analysis,
    generate_outreach_letters,
)
from searchiqs_scraper import create_scraper
from google_client import get_google_client

try:
    import db as database
    DB_AVAILABLE = True
except Exception:
    DB_AVAILABLE = False

RE_STATE_FILE = "real_estate_state.json"
GDOC_URL = "https://docs.google.com/document/d"
GSHEET_URL = "https://docs.google.com/spreadsheets/d"
GDRIVE_URL = "https://drive.google.com/drive/folders"


def _load_state() -> Dict:
    try:
        if os.path.exists(RE_STATE_FILE):
            with open(RE_STATE_FILE, 'r') as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load RE state: {e}")
    return _default_state()


def _default_state() -> Dict:
    return {
        "last_ingest": None,
        "last_analysis": None,
        "last_reviews": None,
        "last_outreach": None,
        "filings_today": 0,
        "filings_by_town": {},
        "leads_high": 0,
        "leads_med": 0,
        "leads_low": 0,
        "reviews_generated": 0,
        "letters_queued": 0,
        "raw_filings": [],
        "analyzed_leads": [],
        "errors": [],
        "documents": {
            "raw_data_sheet_id": None,
            "raw_data_sheet_url": None,
            "logic_doc_id": None,
            "logic_doc_url": None,
            "analysis_docs": {},
            "review_docs": [],
            "letter_docs": [],
            "drive_folder_url": None,
        },
    }


def _save_state(state: Dict):
    try:
        with open(RE_STATE_FILE, 'w') as f:
            json.dump(state, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Failed to save RE state: {e}")


def _today_label() -> str:
    return datetime.now(EASTERN).strftime("%-m/%-d/%Y")


def _today_short() -> str:
    return datetime.now(EASTERN).strftime("%Y-%m-%d")


def _now_ts() -> str:
    return datetime.now(EASTERN).isoformat()


def _get_towns() -> Dict:
    return REAL_ESTATE_CONFIG.get("towns", {})


def _build_analysis_doc_content(town_name: str, town_filings: list, today: str, raw_sheet_id: str = None) -> str:
    run_ts = _now_ts()
    divider = "=" * 60
    content = f"{town_name} Lis Pendens Analysis\n{divider}\n\n"
    content += f"Run Date: {today}\n"
    content += f"Generated: {run_ts}\n"
    content += f"Lookback: {REAL_ESTATE_CONFIG.get('lookback_days', 30)} days\n"
    content += f"Total Filings: {len(town_filings)}\n"
    if raw_sheet_id:
        content += f"Raw Data Sheet: https://docs.google.com/spreadsheets/d/{raw_sheet_id}\n"
    content += "\n"

    if not town_filings:
        content += f"{divider}\n"
        content += "0 Lis Pendens filings found in the last 30 days.\n\n"
        content += "No properties to analyze at this time.\n"
        content += f"{divider}\n"
        return content

    content += f"{divider}\n"
    content += f"FILINGS SUMMARY — {len(town_filings)} PROPERTIES\n"
    content += f"{divider}\n\n"

    for i, f in enumerate(town_filings, 1):
        addr = f.get("property_address", "") or f.get("property_description", "") or "SEE DEED"
        seller = f.get("seller", "") or f.get("party1_seller", "") or "Unknown"
        lender = f.get("lender", "") or f.get("party2_lender", "") or "Unknown"
        rec_date = f.get("recording_date", "") or f.get("recording_date_detail", "") or "N/A"
        mortgage = f.get("original_mortgage", "") or f.get("additional_description", "") or "N/A"
        book_page = f.get("book_page", "") or "N/A"
        court_case = f.get("court_case_number", "") or "N/A"
        debt = f.get("debt_amount", "") or "N/A"
        return_date = f.get("return_date", "") or "N/A"

        content += f"--- Filing #{i} ---\n"
        content += f"  Address:          {addr}\n"
        content += f"  Seller/Defendant: {seller}\n"
        content += f"  Lender/Plaintiff: {lender}\n"
        content += f"  LP Recorded:      {rec_date}\n"
        content += f"  Book/Page:        {book_page}\n"
        content += f"  Original Mortgage:{mortgage}\n"
        content += f"  Court Case #:     {court_case}\n"
        content += f"  Debt Amount:      {debt}\n"
        content += f"  Return Date:      {return_date}\n"
        if f.get("searchiqs_url"):
            content += f"  SearchIQS Link:   {f['searchiqs_url']}\n"
        if f.get("court_url"):
            content += f"  Court Docket:     {f['court_url']}\n"
        content += "\n"

    content += f"{divider}\n"
    content += f"END OF {town_name.upper()} ANALYSIS — {today}\n"
    content += f"{divider}\n"
    return content


def run_0700_searchiqs_ingest() -> Dict:
    logger.info("=== PHASE 1: SearchIQS Data Collection — All Towns (7:00 AM) ===")
    state = _load_state()
    result = {"task": "searchiqs_ingest", "status": "started", "timestamp": _now_ts()}

    today = _today_label()
    folder_id = REAL_ESTATE_CONFIG.get("google_drive_folder_id")
    lookback = REAL_ESTATE_CONFIG.get("lookback_days", 30)
    towns = _get_towns()

    if "documents" not in state:
        state["documents"] = _default_state()["documents"]
    state["documents"]["drive_folder_url"] = f"{GDRIVE_URL}/{folder_id}" if folder_id else None

    try:
        all_filings = []
        filings_by_town = {}
        town_results = {}

        db_towns = []
        town_id_map = {}
        if DB_AVAILABLE:
            try:
                db_towns = database.get_towns()
                town_id_map = {t["name"]: t["id"] for t in db_towns}
            except Exception as e:
                logger.error(f"Failed to load towns from DB: {e}")

        town_scrape_statuses = {}

        for town_name, town_cfg in towns.items():
            base_url = town_cfg["base_url"]
            logger.info(f"--- Scraping {town_name} ({base_url}) ---")
            scrape_status = "OK"

            try:
                scraper = create_scraper(base_url=base_url, town_name=town_name)
                town_filings = scraper.search_lis_pendens(days_back=lookback, fetch_details=True)
            except requests.exceptions.HTTPError as e:
                if "403" in str(e):
                    scrape_status = "HTTP_403"
                else:
                    scrape_status = "ERROR"
                logger.warning(f"[{town_name}] Scrape failed ({scrape_status}): {e}")
                town_filings = []
            except Exception as e:
                scrape_status = "ERROR"
                logger.warning(f"[{town_name}] Scrape failed: {e}")
                town_filings = []

            if scrape_status == "OK" and len(town_filings) == 0:
                scrape_status = "ZERO_RESULTS"

            town_scrape_statuses[town_name] = scrape_status

            court_lookup_enabled = os.getenv("COURT_LOOKUP_ENABLED", "false").lower() == "true"
            if court_lookup_enabled and town_filings:
                court_lookup_failures = 0
                for filing in town_filings:
                    defendant = filing.get("seller", "") or filing.get("defendant", "")
                    if defendant and not filing.get("court_case_number") and court_lookup_failures < 2:
                        if defendant.strip() in ("", "&nbsp;&nbsp;", "&nbsp;"):
                            continue
                        try:
                            court_info = scraper.search_court_case(defendant)
                            if court_info:
                                filing["court_case_number"] = court_info.get("case_number", "")
                                filing["court_url"] = court_info.get("court_url", "")
                                if court_info.get("debt_amount") and court_info["debt_amount"] != "Unknown":
                                    filing["debt_amount"] = court_info["debt_amount"]
                                if court_info.get("return_date") and court_info["return_date"] != "TBD":
                                    filing["return_date"] = court_info["return_date"]
                            time.sleep(1)
                        except Exception as e:
                            court_lookup_failures += 1
                            logger.warning(f"Court lookup failed ({court_lookup_failures}/2), skipping remaining: {e}")
            elif not court_lookup_enabled:
                logger.info(f"Court lookups disabled (SSL issues with CT courts site)")

            filings_by_town[town_name] = len(town_filings)
            town_results[town_name] = town_filings
            all_filings.extend(town_filings)
            logger.info(f"{town_name}: {len(town_filings)} filings found (status: {scrape_status})")

            tid = town_id_map.get(town_name)
            if DB_AVAILABLE and tid:
                try:
                    database.update_town_scrape_status(tid, scrape_status)
                except Exception as e:
                    logger.warning(f"Failed to update scrape status for {town_name}: {e}")

            time.sleep(2)

        state["raw_filings"] = all_filings
        state["filings_today"] = len(all_filings)
        state["filings_by_town"] = filings_by_town
        state["last_ingest"] = _now_ts()

        if DB_AVAILABLE:
            try:
                run_id = database.create_pipeline_run("searchiqs_ingest")
                db_filings_inserted = 0
                for town_name in towns:
                    tid = town_id_map.get(town_name)
                    if not tid:
                        continue
                    town_filings_list = town_results.get(town_name, [])
                    for f in town_filings_list:
                        f["town"] = town_name
                    count = database.replace_filings_for_town(tid, town_filings_list)
                    db_filings_inserted += count
                database.complete_pipeline_run(
                    run_id, towns_scraped=len(towns),
                    filings_found=db_filings_inserted,
                    status="completed",
                    details={"filings_by_town": filings_by_town, "scrape_statuses": town_scrape_statuses}
                )
                logger.info(f"Wrote {db_filings_inserted} filings to Postgres")
            except Exception as e:
                logger.error(f"DB write failed (non-fatal): {e}")

        google = get_google_client()

        raw_sheet_id = REAL_ESTATE_CONFIG.get("raw_data_sheet_id") or None
        if google.credentials:
            sheet_title = f"Hartford County Lis Pendens Raw Data - {today}"
            if not raw_sheet_id:
                raw_sheet_id = google.create_spreadsheet(sheet_title, folder_id)
            else:
                google._clear_spreadsheet(raw_sheet_id)
                google._rename_file(raw_sheet_id, sheet_title)
                logger.info(f"Reusing pre-configured raw data sheet: {raw_sheet_id}")

            if raw_sheet_id:
                state["documents"]["raw_data_sheet_id"] = raw_sheet_id
                state["documents"]["raw_data_sheet_url"] = f"{GSHEET_URL}/{raw_sheet_id}"

                header = [["Town", "Address", "Seller", "Lender", "LP Date", "Original Mortgage",
                           "Court Case#", "Debt Amount", "Return Date", "Status"]]
                google.append_rows(raw_sheet_id, "Sheet1", header)

                for town_name in towns:
                    town_filings = town_results.get(town_name, [])
                    if town_filings:
                        rows = []
                        for f in town_filings:
                            rows.append([
                                f.get("town", town_name),
                                f.get("property_address", "") or f.get("property_description", "SEE DEED"),
                                f.get("seller", "") or f.get("party1_seller", ""),
                                f.get("lender", "") or f.get("party2_lender", ""),
                                f.get("recording_date", "") or f.get("recording_date_detail", ""),
                                f.get("original_mortgage", "") or f.get("additional_description", ""),
                                f.get("court_case_number", ""),
                                f.get("debt_amount", ""),
                                f.get("return_date", ""),
                                f.get("status", "PENDING"),
                            ])
                        google.append_rows(raw_sheet_id, "Sheet1", rows)
                    else:
                        google.append_rows(raw_sheet_id, "Sheet1", [[town_name, "— No Lis Pendens filings found in last 30 days —", "", "", "", "", "", "", "", ""]])

                logger.info(f"Raw Data sheet ready: {sheet_title} ({raw_sheet_id})")

        logic_doc_id = REAL_ESTATE_CONFIG.get("logic_doc_id") or None
        if google.credentials:
            logic_title = f"LOGIC - Hartford County Lis Pendens - {today}"
            if not logic_doc_id:
                logic_doc_id = google.create_document(logic_title, folder_id)
            else:
                google._rename_file(logic_doc_id, logic_title)
                logger.info(f"Reusing pre-configured LOGIC doc: {logic_doc_id}")
            if logic_doc_id:
                state["documents"]["logic_doc_id"] = logic_doc_id
                state["documents"]["logic_doc_url"] = f"{GDOC_URL}/{logic_doc_id}"

                logic_content = f"LOGIC - Hartford County Lis Pendens - {today}\n{'='*60}\n\n"
                logic_content += f"Generated: {_now_ts()}\n"
                logic_content += f"Lookback Period: {lookback} days\n"
                logic_content += f"Towns Searched: {', '.join(towns.keys())}\n"
                logic_content += f"Total Filings Found: {len(all_filings)}\n\n"

                if raw_sheet_id:
                    logic_content += f"Raw Data Sheet: {GSHEET_URL}/{raw_sheet_id}\n\n"

                for town_name, town_cfg in towns.items():
                    town_filings = town_results.get(town_name, [])
                    logic_content += f"\n{'='*60}\n"
                    logic_content += f"TOWN: {town_name.upper()} — {len(town_filings)} filing(s)\n"
                    logic_content += f"SearchIQS: {town_cfg['base_url']}/SearchAdvancedMP.aspx\n"
                    logic_content += f"{'='*60}\n\n"

                    if not town_filings:
                        logic_content += "No Lis Pendens filings found in last 30 days.\n\n"
                    else:
                        for i, f in enumerate(town_filings, 1):
                            addr = f.get("property_address", "") or f.get("seller", "Unknown")
                            logic_content += f"{i}. {addr}\n"
                            if f.get("searchiqs_url"):
                                logic_content += f"   SearchIQS: {f['searchiqs_url']}\n"
                            if f.get("court_url"):
                                logic_content += f"   Court Docket: {f['court_url']}\n"
                            if f.get("court_case_number"):
                                logic_content += f"   Case #: {f['court_case_number']}\n"
                            logic_content += f"   Recorded: {f.get('recording_date', 'N/A')}\n"
                            logic_content += f"   Book/Page: {f.get('book_page', 'N/A')}\n\n"

                google.write_document_content(logic_doc_id, logic_content)
                logger.info(f"Created LOGIC doc: {logic_title} ({logic_doc_id})")

        analysis_docs_by_town = {}
        if google.credentials:
            for town_name, town_cfg in towns.items():
                town_filings = town_results.get(town_name, [])
                analysis_title = f"{town_name} Lis Pendens Analysis - {today}"
                pre_configured_id = town_cfg.get("analysis_doc_id", "")
                if pre_configured_id:
                    analysis_doc_id = pre_configured_id
                    google._rename_file(analysis_doc_id, analysis_title)
                    logger.info(f"Reusing pre-configured analysis doc for {town_name}: {analysis_doc_id}")
                else:
                    analysis_doc_id = google.create_document(analysis_title, folder_id)
                if analysis_doc_id:
                    analysis_docs_by_town[town_name] = {
                        "doc_id": analysis_doc_id,
                        "url": f"{GDOC_URL}/{analysis_doc_id}",
                        "title": analysis_title,
                    }

                    content = _build_analysis_doc_content(town_name, town_filings, today, raw_sheet_id)
                    google.write_document_content(analysis_doc_id, content)
                    logger.info(f"Wrote Analysis doc for {town_name}: {len(town_filings)} filings")

            state["documents"]["analysis_docs"] = analysis_docs_by_town

        _save_state(state)

        result["status"] = "success"
        result["filings_found"] = len(all_filings)
        result["filings_by_town"] = filings_by_town
        result["message"] = f"Scraped {len(all_filings)} Lis Pendens filings across {len(towns)} towns: " + ", ".join(f"{t}: {c}" for t, c in filings_by_town.items())
        result["raw_data_sheet_url"] = state["documents"].get("raw_data_sheet_url")
        result["logic_doc_url"] = state["documents"].get("logic_doc_url")
        logger.info(f"Phase 1 complete: {result['message']}")

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
        state.setdefault("errors", []).append({"task": "ingest", "error": str(e), "time": _now_ts()})
        _save_state(state)
        logger.error(f"Phase 1 error: {e}")

    return result


def run_0730_analysis() -> Dict:
    logger.info("=== PHASE 2: Analysis + REVIEW Docs — All Towns (7:30 AM) ===")
    state = _load_state()
    result = {"task": "analysis", "status": "started", "timestamp": _now_ts()}

    today = _today_label()
    folder_id = REAL_ESTATE_CONFIG.get("google_drive_folder_id")
    template_id = REAL_ESTATE_CONFIG.get("review_template_doc_id")
    towns = _get_towns()

    try:
        filings = state.get("raw_filings", [])
        if not filings:
            result["status"] = "skipped"
            result["message"] = "No filings to analyze"

            google = get_google_client()
            analysis_docs = state.get("documents", {}).get("analysis_docs", {})
            for town_name in towns:
                town_doc = analysis_docs.get(town_name)
                if town_doc and google.credentials:
                    doc_id = town_doc["doc_id"]
                    content = f"{town_name} Lis Pendens Analysis - {today}\n{'='*60}\n\n"
                    content += f"Generated: {_now_ts()}\n\n"
                    content += "0 Lis Pendens filings found in the last 30 days.\n"
                    content += "No properties to analyze at this time.\n"
                    google.write_document_content(doc_id, content)

            return result

        equity_high = REAL_ESTATE_CONFIG["equity_thresholds"]["high"]
        equity_med = REAL_ESTATE_CONFIG["equity_thresholds"]["medium"]
        rehab_pct = REAL_ESTATE_CONFIG["rehab_cost_pct"]
        closing = REAL_ESTATE_CONFIG["closing_costs"]

        analyzed = []
        for filing in filings:
            town = filing.get("town", "Hartford")
            address = filing.get("property_address", "") or filing.get("property_description", "")
            seller = filing.get("seller", "") or filing.get("party1_seller", "")
            lender = filing.get("lender", "") or filing.get("party2_lender", "")
            case_num = filing.get("court_case_number", "")
            debt_str = filing.get("debt_amount", "0")
            if isinstance(debt_str, str):
                debt_amount = float(debt_str.replace("$", "").replace(",", "")) if debt_str and debt_str not in ("Unknown", "", "0") else 0
            else:
                debt_amount = float(debt_str) if debt_str else 0

            system_prompt = (
                f"You are a CT real estate data analyst. Given a property address in {town} CT, "
                "estimate the current market value based on recent comparable sales, Zillow estimates, and Redfin data. "
                "Return ONLY a JSON object: {\"estimated_value\": NUMBER, \"confidence\": \"high\"|\"medium\"|\"low\", "
                "\"zillow_url\": \"URL or empty\", \"redfin_url\": \"URL or empty\", \"comps_summary\": \"brief text\", "
                "\"valuation_source\": \"source description\"}"
            )
            search_addr = address if address and address.upper() != "SEE DEED" else f"{seller}, {town} CT"
            user_prompt = f"Property: {search_addr}, {town}, CT. Estimate current market value with sources."

            market_value = 0
            valuation_data = {}
            try:
                value_response = perplexity_chat(system_prompt, user_prompt, max_tokens=500)
                try:
                    cleaned_resp = value_response.strip().strip('`').strip()
                    if cleaned_resp.startswith('{'):
                        valuation_data = json.loads(cleaned_resp)
                    else:
                        json_match = __import__('re').search(r'\{[^}]+\}', cleaned_resp)
                        if json_match:
                            valuation_data = json.loads(json_match.group(0))
                    market_value = valuation_data.get("estimated_value", 0)
                except (json.JSONDecodeError, ValueError):
                    import re as _re
                    val_match = _re.search(r'\$?([\d,]+)', value_response)
                    market_value = float(val_match.group(1).replace(",", "")) if val_match else 0
            except Exception as e:
                logger.warning(f"Value estimate failed for {search_addr}: {e}")

            rehab_cost = market_value * rehab_pct
            equity = market_value - debt_amount - rehab_cost - closing

            if equity >= equity_high:
                priority = "HIGH"
            elif equity >= equity_med:
                priority = "MED"
            else:
                priority = "LOW"

            outreach_angle = ""
            if priority == "HIGH":
                outreach_angle = "Strong equity position - direct cash offer approach with emphasis on quick closing and debt relief"
            elif priority == "MED":
                outreach_angle = "Moderate equity - explore short sale or subject-to options, emphasize timeline pressure"
            else:
                outreach_angle = "Low equity - monitor only, may not support acquisition at this time"

            lead = {
                "town": town,
                "address": address,
                "seller": seller,
                "lender": lender,
                "recording_date": filing.get("recording_date", ""),
                "market_value": round(market_value, 2),
                "debt_amount": round(debt_amount, 2),
                "rehab_cost": round(rehab_cost, 2),
                "closing_costs": closing,
                "estimated_equity": round(equity, 2),
                "priority": priority,
                "court_case_number": case_num,
                "return_date": filing.get("return_date", "TBD"),
                "status": filing.get("status", "PENDING"),
                "searchiqs_url": filing.get("searchiqs_url", ""),
                "court_url": filing.get("court_url", ""),
                "book_page": filing.get("book_page", ""),
                "original_mortgage": filing.get("original_mortgage", ""),
                "zillow_url": valuation_data.get("zillow_url", ""),
                "redfin_url": valuation_data.get("redfin_url", ""),
                "valuation_source": valuation_data.get("valuation_source", ""),
                "comps_summary": valuation_data.get("comps_summary", ""),
                "outreach_angle": outreach_angle,
                "title_search_recommendation": "Recommended" if priority in ("HIGH", "MED") else "Not required at this stage",
                "review_doc_id": None,
                "review_doc_url": None,
                "letters_doc_id": None,
                "letters_doc_url": None,
            }

            if priority in ("HIGH", "MED") and (address or seller):
                try:
                    analysis = generate_property_analysis(address or seller, market_value, debt_amount, equity)
                    lead["perplexity_analysis"] = analysis
                except Exception as e:
                    logger.warning(f"Property analysis failed for {address}: {e}")
                    lead["perplexity_analysis"] = f"[ERROR] {e}"

            analyzed.append(lead)
            time.sleep(2)

        google = get_google_client()

        analysis_docs = state.get("documents", {}).get("analysis_docs", {})
        for town_name in towns:
            town_leads = [l for l in analyzed if l.get("town") == town_name]
            town_doc = analysis_docs.get(town_name)
            if not town_doc or not google.credentials:
                continue

            doc_id = town_doc["doc_id"]
            content = f"{town_name} Lis Pendens Analysis - {today}\n{'='*60}\n\n"
            content += f"Generated: {_now_ts()}\n"
            content += f"Total Filings Analyzed: {len(town_leads)}\n"

            if not town_leads:
                content += "\n0 Lis Pendens filings found in the last 30 days.\n"
                content += "No properties to analyze at this time.\n"
            else:
                content += f"HIGH Priority: {sum(1 for l in town_leads if l['priority'] == 'HIGH')}\n"
                content += f"MED Priority: {sum(1 for l in town_leads if l['priority'] == 'MED')}\n"
                content += f"LOW Priority: {sum(1 for l in town_leads if l['priority'] == 'LOW')}\n\n"

                for i, lead in enumerate(town_leads, 1):
                    content += f"\n{'='*50}\n"
                    content += f"PROPERTY {i}: {lead['address'] or lead['seller']}\n"
                    content += f"{'='*50}\n"
                    content += f"Town: {town_name}\n"
                    content += f"Address: {lead['address']}\n"
                    content += f"Seller: {lead['seller']}\n"
                    content += f"Lender: {lead['lender']}\n"
                    content += f"Filing Date: {lead['recording_date']}\n"
                    content += f"Court Case #: {lead['court_case_number']}\n"
                    content += f"Book/Page: {lead['book_page']}\n"
                    content += f"Original Mortgage: {lead['original_mortgage']}\n"
                    content += f"Return Date: {lead['return_date']}\n"
                    content += f"Status: {lead['status']}\n\n"
                    content += f"VALUATION\n{'-'*30}\n"
                    content += f"Estimated Market Value: ${lead['market_value']:,.0f}\n"
                    content += f"Known Debt: ${lead['debt_amount']:,.0f}\n"
                    content += f"Rehab Cost (5%): ${lead['rehab_cost']:,.0f}\n"
                    content += f"Closing Costs: ${lead['closing_costs']:,.0f}\n"
                    content += f"ESTIMATED EQUITY: ${lead['estimated_equity']:,.0f}\n"
                    content += f"Priority: {lead['priority']}\n"
                    content += f"Valuation Source: {lead['valuation_source']}\n"
                    content += f"Comps Summary: {lead['comps_summary']}\n\n"
                    content += f"RECOMMENDATIONS\n{'-'*30}\n"
                    content += f"Title Search: {lead['title_search_recommendation']}\n"
                    content += f"Outreach Priority: {lead['priority']}\n"
                    content += f"Suggested Outreach Angle: {lead['outreach_angle']}\n\n"
                    if lead.get("perplexity_analysis"):
                        content += f"DETAILED ANALYSIS\n{'-'*30}\n{lead['perplexity_analysis']}\n\n"
                    if lead.get("zillow_url"):
                        content += f"Zillow: {lead['zillow_url']}\n"
                    if lead.get("redfin_url"):
                        content += f"Redfin: {lead['redfin_url']}\n"
                    if lead.get("searchiqs_url"):
                        content += f"SearchIQS: {lead['searchiqs_url']}\n"
                    if lead.get("court_url"):
                        content += f"Court Docket: {lead['court_url']}\n"

            google.write_document_content(doc_id, content)
            logger.info(f"Wrote {town_name} Analysis doc: {len(town_leads)} leads")

        high_leads = [l for l in analyzed if l["priority"] == "HIGH"]
        review_docs = []

        if google.credentials and high_leads:
            for lead in high_leads:
                addr = lead.get("address", "") or lead.get("seller", "Unknown")
                town = lead.get("town", "Hartford")

                case_summary = ""
                if lead.get("court_case_number") and lead["court_case_number"] not in ("N/A", "", "Not found"):
                    try:
                        case_summary = generate_case_law_summary(addr, lead["court_case_number"])
                    except Exception as e:
                        case_summary = f"[Case law lookup failed: {e}]"

                review_title = f"REVIEW {addr} pre-auction"

                if template_id:
                    try:
                        doc_id = google.copy_document(template_id, review_title, folder_id)
                        if doc_id:
                            replacements = {
                                "{{PROPERTY_ADDRESS}}": addr,
                                "{{TOWN}}": town,
                                "{{OWNER_NAME}}": lead.get("seller", "N/A"),
                                "{{PLAINTIFF}}": lead.get("lender", "N/A"),
                                "{{MARKET_VALUE}}": f"${lead.get('market_value', 0):,.0f}",
                                "{{DEBT_AMOUNT}}": f"${lead.get('debt_amount', 0):,.0f}",
                                "{{ESTIMATED_EQUITY}}": f"${lead.get('estimated_equity', 0):,.0f}",
                                "{{PRIORITY}}": lead.get("priority", "N/A"),
                                "{{CASE_NUMBER}}": lead.get("court_case_number", "N/A"),
                                "{{RETURN_DATE}}": lead.get("return_date", "TBD"),
                                "{{CASE_SUMMARY}}": case_summary[:2000],
                                "{{ANALYSIS}}": lead.get("perplexity_analysis", "")[:2000],
                                "{{DATE}}": today,
                                "{{OUTREACH_ANGLE}}": lead.get("outreach_angle", ""),
                                "{{COMPS_SUMMARY}}": lead.get("comps_summary", ""),
                            }
                            google.replace_text_in_doc(doc_id, replacements)
                            lead["review_doc_id"] = doc_id
                            lead["review_doc_url"] = f"{GDOC_URL}/{doc_id}"
                            review_docs.append({"address": addr, "town": town, "doc_id": doc_id, "url": f"{GDOC_URL}/{doc_id}"})
                            logger.info(f"Created REVIEW doc from template: {review_title}")
                    except Exception as e:
                        logger.error(f"Failed to create REVIEW from template for {addr}: {e}")
                else:
                    try:
                        doc_id = google.create_document(review_title, folder_id)
                        if doc_id:
                            review_content = (
                                f"REVIEW - {addr} ({town}) - Pre-Auction\n{'='*50}\n\n"
                                f"Date: {today}\n\n"
                                f"PROPERTY DETAILS\n{'-'*30}\n"
                                f"Address: {addr}\n"
                                f"Town: {town}\n"
                                f"Owner: {lead.get('seller', 'N/A')}\n"
                                f"Plaintiff/Lender: {lead.get('lender', 'N/A')}\n"
                                f"Case #: {lead.get('court_case_number', 'N/A')}\n"
                                f"Return Date: {lead.get('return_date', 'TBD')}\n\n"
                                f"FINANCIAL ANALYSIS\n{'-'*30}\n"
                                f"Estimated Market Value: ${lead.get('market_value', 0):,.0f}\n"
                                f"Known Debt: ${lead.get('debt_amount', 0):,.0f}\n"
                                f"Rehab (5%): ${lead.get('rehab_cost', 0):,.0f}\n"
                                f"Closing Costs: ${lead.get('closing_costs', 0):,.0f}\n"
                                f"ESTIMATED EQUITY: ${lead.get('estimated_equity', 0):,.0f}\n"
                                f"Priority: {lead.get('priority', 'N/A')}\n\n"
                                f"CASE SUMMARY\n{'-'*30}\n{case_summary}\n\n"
                                f"MARKET ANALYSIS\n{'-'*30}\n{lead.get('perplexity_analysis', 'N/A')}\n\n"
                                f"OUTREACH STRATEGY\n{'-'*30}\n{lead.get('outreach_angle', 'N/A')}\n"
                            )
                            google.write_document_content(doc_id, review_content)
                            lead["review_doc_id"] = doc_id
                            lead["review_doc_url"] = f"{GDOC_URL}/{doc_id}"
                            review_docs.append({"address": addr, "town": town, "doc_id": doc_id, "url": f"{GDOC_URL}/{doc_id}"})
                            logger.info(f"Created REVIEW doc: {review_title}")
                    except Exception as e:
                        logger.error(f"Failed to create REVIEW for {addr}: {e}")

                time.sleep(2)

        logic_doc_id = state.get("documents", {}).get("logic_doc_id")
        if logic_doc_id and google.credentials:
            logic_update = f"\n\n{'='*60}\nPHASE 2 UPDATE - Analysis Complete ({_now_ts()})\n{'='*60}\n\n"

            for town_name in towns:
                town_doc = analysis_docs.get(town_name)
                if town_doc:
                    logic_update += f"{town_name} Analysis: {town_doc['url']}\n"

            logic_update += f"\nVALUATION SOURCES\n" + "-"*40 + "\n"
            for lead in analyzed:
                addr = lead.get("address", "") or lead.get("seller", "")
                town = lead.get("town", "")
                logic_update += f"\n[{town}] {addr}:\n"
                logic_update += f"  Priority: {lead['priority']}\n"
                logic_update += f"  Market Value: ${lead['market_value']:,.0f}\n"
                logic_update += f"  Equity: ${lead['estimated_equity']:,.0f}\n"
                logic_update += f"  Source: {lead.get('valuation_source', 'Perplexity AI')}\n"
                if lead.get("zillow_url"):
                    logic_update += f"  Zillow: {lead['zillow_url']}\n"
                if lead.get("redfin_url"):
                    logic_update += f"  Redfin: {lead['redfin_url']}\n"
                logic_update += f"  Payoff Calc: Market ${lead['market_value']:,.0f} - Debt ${lead['debt_amount']:,.0f} - Rehab ${lead['rehab_cost']:,.0f} - Closing ${lead['closing_costs']:,.0f} = ${lead['estimated_equity']:,.0f}\n"
                logic_update += f"  Priority Reasoning: {lead.get('outreach_angle', '')}\n"

            google.append_document_content(logic_doc_id, logic_update)

        state["analyzed_leads"] = analyzed
        state["leads_high"] = sum(1 for l in analyzed if l["priority"] == "HIGH")
        state["leads_med"] = sum(1 for l in analyzed if l["priority"] == "MED")
        state["leads_low"] = sum(1 for l in analyzed if l["priority"] == "LOW")
        state["last_analysis"] = _now_ts()
        state.setdefault("documents", {})["review_docs"] = review_docs
        state["reviews_generated"] = len(review_docs)
        _save_state(state)

        result["status"] = "success"
        result["analyzed"] = len(analyzed)
        result["high"] = state["leads_high"]
        result["med"] = state["leads_med"]
        result["low"] = state["leads_low"]
        result["reviews_created"] = len(review_docs)
        result["message"] = f"Analyzed {len(analyzed)} leads: {state['leads_high']} HIGH, {state['leads_med']} MED, {state['leads_low']} LOW. Created {len(review_docs)} REVIEW docs."
        logger.info(result["message"])

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
        state.setdefault("errors", []).append({"task": "analysis", "error": str(e), "time": _now_ts()})
        _save_state(state)
        logger.error(f"Phase 2 error: {e}")

    return result


def run_0800_reviews() -> Dict:
    logger.info("=== PHASE 3: Update LOGIC with REVIEW Doc URLs (8:00 AM) ===")
    state = _load_state()
    result = {"task": "reviews", "status": "started", "timestamp": _now_ts()}

    try:
        review_docs = state.get("documents", {}).get("review_docs", [])
        logic_doc_id = state.get("documents", {}).get("logic_doc_id")

        if not review_docs:
            result["status"] = "skipped"
            result["message"] = "No REVIEW docs to link in LOGIC"
            state["last_reviews"] = _now_ts()
            _save_state(state)
            return result

        google = get_google_client()

        if logic_doc_id and google.credentials:
            logic_update = f"\n\n{'='*60}\nPHASE 3 UPDATE - REVIEW Docs Linked ({_now_ts()})\n{'='*60}\n\n"
            logic_update += "REVIEW DOCUMENTS CREATED\n" + "-"*40 + "\n\n"
            for rd in review_docs:
                logic_update += f"Property: {rd['address']} ({rd.get('town', '')})\n"
                logic_update += f"REVIEW Doc: {rd['url']}\n\n"

            google.append_document_content(logic_doc_id, logic_update)
            logger.info(f"Updated LOGIC doc with {len(review_docs)} REVIEW links")

        state["last_reviews"] = _now_ts()
        _save_state(state)

        result["status"] = "success"
        result["reviews_linked"] = len(review_docs)
        result["message"] = f"Linked {len(review_docs)} REVIEW docs in LOGIC document"
        logger.info(result["message"])

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
        state.setdefault("errors", []).append({"task": "reviews", "error": str(e), "time": _now_ts()})
        _save_state(state)
        logger.error(f"Phase 3 error: {e}")

    return result


def run_0830_outreach() -> Dict:
    logger.info("=== PHASE 4: Outreach Letters (8:30 AM) ===")
    state = _load_state()
    result = {"task": "outreach", "status": "started", "timestamp": _now_ts()}

    today = _today_label()
    folder_id = REAL_ESTATE_CONFIG.get("google_drive_folder_id")

    try:
        analyzed = state.get("analyzed_leads", [])
        high_leads = [l for l in analyzed if l.get("priority") == "HIGH"]

        if not high_leads:
            result["status"] = "skipped"
            result["message"] = "No HIGH priority leads for outreach"
            state["last_outreach"] = _now_ts()
            _save_state(state)
            return result

        google = get_google_client()
        letter_docs = []

        for lead in high_leads:
            address = lead.get("address", "") or lead.get("seller", "Unknown")
            town = lead.get("town", "Hartford")
            owner = lead.get("seller", "Property Owner")
            lender_name = lead.get("lender", "")
            analysis = lead.get("perplexity_analysis", "")

            try:
                letters_text = generate_outreach_letters(
                    owner_name=owner,
                    property_address=f"{address}, {town}, CT",
                    summary=analysis[:500],
                    lender=lender_name,
                    court_date=lead.get("return_date", "TBD"),
                    years_at_property=0,
                    equity_estimate=max(0, lead.get("estimated_equity", 0)),
                )

                if google.credentials:
                    doc_title = f"LETTERS TO {address}"
                    doc_id = google.create_document(doc_title, folder_id)
                    if doc_id:
                        letter_content = (
                            f"LETTERS TO {address} ({town})\n{'='*50}\n\n"
                            f"Prepared: {today}\n"
                            f"Property: {address}, {town}, CT\n"
                            f"Owner: {owner}\n\n"
                            f"{'='*50}\n"
                            f"LETTER #1 - FIRST CONTACT\n"
                            f"{'='*50}\n\n"
                        )

                        if "LETTER #2" in letters_text or "Letter #2" in letters_text or "FOLLOW-UP" in letters_text.upper():
                            letter_content += letters_text
                        else:
                            letter_content += letters_text
                            letter_content += f"\n\n{'='*50}\n"
                            letter_content += "LETTER #2 - FOLLOW-UP (Send after 7 days)\n"
                            letter_content += f"{'='*50}\n\n"
                            letter_content += "[Follow-up letter included above or to be generated separately]\n"

                        google.write_document_content(doc_id, letter_content)
                        lead["letters_doc_id"] = doc_id
                        lead["letters_doc_url"] = f"{GDOC_URL}/{doc_id}"
                        letter_docs.append({"address": address, "town": town, "doc_id": doc_id, "url": f"{GDOC_URL}/{doc_id}"})
                        logger.info(f"Created LETTERS doc: {doc_title}")
                else:
                    letter_docs.append({"address": address, "town": town, "doc_id": None, "url": None})

            except Exception as e:
                logger.error(f"Failed to generate letters for {address}: {e}")

            time.sleep(3)

        logic_doc_id = state.get("documents", {}).get("logic_doc_id")
        if logic_doc_id and google.credentials and letter_docs:
            logic_update = f"\n\n{'='*60}\nPHASE 4 UPDATE - LETTERS Created ({_now_ts()})\n{'='*60}\n\n"
            logic_update += "OUTREACH LETTERS CREATED\n" + "-"*40 + "\n\n"
            for ld in letter_docs:
                logic_update += f"Property: {ld['address']} ({ld.get('town', '')})\n"
                if ld.get('url'):
                    logic_update += f"LETTERS Doc: {ld['url']}\n"
                logic_update += "\n"

            logic_update += f"\n{'='*60}\n"
            logic_update += f"PIPELINE COMPLETE - {_now_ts()}\n"
            logic_update += f"{'='*60}\n"

            google.append_document_content(logic_doc_id, logic_update)
            logger.info("Updated LOGIC doc with LETTERS links - pipeline complete")

        state["letters_queued"] = len(letter_docs)
        state["last_outreach"] = _now_ts()
        state.setdefault("documents", {})["letter_docs"] = letter_docs
        state["analyzed_leads"] = analyzed
        _save_state(state)

        result["status"] = "success"
        result["letters_created"] = len(letter_docs)
        result["message"] = f"Generated {len(letter_docs)} letter sets for {len(high_leads)} HIGH leads"
        logger.info(result["message"])

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
        state.setdefault("errors", []).append({"task": "outreach", "error": str(e), "time": _now_ts()})
        _save_state(state)
        logger.error(f"Phase 4 error: {e}")

    return result


def get_real_estate_status() -> Dict:
    state = _load_state()
    docs = state.get("documents", {})

    high_leads = []
    for lead in state.get("analyzed_leads", []):
        if lead.get("priority") == "HIGH":
            high_leads.append({
                "address": lead.get("address", "") or lead.get("seller", ""),
                "town": lead.get("town", ""),
                "equity": lead.get("estimated_equity", 0),
                "review_url": lead.get("review_doc_url"),
                "letters_url": lead.get("letters_doc_url"),
                "court_case": lead.get("court_case_number", ""),
                "return_date": lead.get("return_date", ""),
            })

    analysis_docs_list = []
    for town_name, doc_info in docs.get("analysis_docs", {}).items():
        analysis_docs_list.append({
            "town": town_name,
            "url": doc_info.get("url"),
            "title": doc_info.get("title", ""),
        })

    return {
        "filings_today": state.get("filings_today", 0),
        "filings_by_town": state.get("filings_by_town", {}),
        "leads_high": state.get("leads_high", 0),
        "leads_med": state.get("leads_med", 0),
        "leads_low": state.get("leads_low", 0),
        "reviews_generated": state.get("reviews_generated", 0),
        "letters_queued": state.get("letters_queued", 0),
        "last_ingest": state.get("last_ingest"),
        "last_analysis": state.get("last_analysis"),
        "last_reviews": state.get("last_reviews"),
        "last_outreach": state.get("last_outreach"),
        "errors": state.get("errors", [])[-5:],
        "pipeline_active": True,
        "high_leads": high_leads,
        "raw_data_sheet_url": docs.get("raw_data_sheet_url"),
        "logic_doc_url": docs.get("logic_doc_url"),
        "analysis_docs": analysis_docs_list,
        "analysis_doc_url": analysis_docs_list[0]["url"] if analysis_docs_list else None,
        "review_docs": docs.get("review_docs", []),
        "letter_docs": docs.get("letter_docs", []),
        "drive_folder_url": docs.get("drive_folder_url"),
    }


def check_and_run_scheduled_tasks() -> Optional[Dict]:
    now = datetime.now(EASTERN)
    current_hour = now.hour
    current_minute = now.minute

    tasks = REAL_ESTATE_CONFIG.get("tasks", {})
    state = _load_state()

    today_str = now.strftime("%Y-%m-%d")

    def already_ran(state_key):
        last_run = state.get(f"last_{state_key}")
        if not last_run:
            return False
        try:
            last_dt = datetime.fromisoformat(last_run)
            return last_dt.strftime("%Y-%m-%d") == today_str
        except Exception:
            return False

    task_map = {
        "searchiqs_ingest": ("ingest", run_0700_searchiqs_ingest),
        "analysis": ("analysis", run_0730_analysis),
        "reviews": ("reviews", run_0800_reviews),
        "outreach": ("outreach", run_0830_outreach),
    }

    for task_name, schedule in tasks.items():
        target_hour = schedule["hour"]
        target_minute = schedule["minute"]

        if current_hour == target_hour and abs(current_minute - target_minute) <= 2:
            if task_name not in task_map:
                continue

            state_key, task_fn = task_map[task_name]

            if already_ran(state_key):
                continue

            logger.info(f"Scheduled task triggered: {task_name} at {current_hour}:{current_minute:02d}")
            return task_fn()

    return None


logger.info("Real estate tasks module loaded (v3 - multi-town pipeline)")
