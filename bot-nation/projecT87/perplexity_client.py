import os
import json
import requests
import logging
import time

logger = logging.getLogger(__name__)

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")
PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions"
DEFAULT_MODEL = "sonar"


def perplexity_chat(system_prompt: str, user_prompt: str, model: str = None, max_tokens: int = 2048) -> str:
    api_key = os.getenv("PERPLEXITY_API_KEY")
    if not api_key:
        logger.error("PERPLEXITY_API_KEY not set")
        return "[ERROR] Perplexity API key not configured"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "top_p": 0.9,
        "stream": False,
        "frequency_penalty": 1,
    }

    try:
        logger.info(f"Perplexity API call: model={payload['model']}, prompt_len={len(user_prompt)}")
        resp = requests.post(PERPLEXITY_API_URL, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        citations = data.get("citations", [])
        usage = data.get("usage", {})
        logger.info(f"Perplexity response: {len(content)} chars, {usage.get('total_tokens', 0)} tokens, {len(citations)} citations")
        return content
    except requests.exceptions.HTTPError as e:
        logger.error(f"Perplexity API HTTP error: {e}")
        return f"[ERROR] Perplexity API: {e}"
    except requests.exceptions.Timeout:
        logger.error("Perplexity API timeout")
        return "[ERROR] Perplexity API timeout"
    except Exception as e:
        logger.error(f"Perplexity API error: {e}")
        return f"[ERROR] Perplexity API: {e}"


def perplexity_chat_multi(system_prompt: str, history: list, user_prompt: str, model: str = None, max_tokens: int = 2048) -> str:
    api_key = os.getenv("PERPLEXITY_API_KEY")
    if not api_key:
        logger.error("PERPLEXITY_API_KEY not set")
        return "[ERROR] Perplexity API key not configured"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    messages = [{"role": "system", "content": system_prompt}]
    for msg in history[-5:]:
        role = msg.get("role", "user")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": msg.get("content", "")})
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "top_p": 0.9,
        "stream": False,
        "frequency_penalty": 1,
    }

    try:
        logger.info(f"Perplexity multi-turn API call: model={payload['model']}, turns={len(messages)}")
        resp = requests.post(PERPLEXITY_API_URL, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        logger.info(f"Perplexity response: {len(content)} chars, {usage.get('total_tokens', 0)} tokens")
        return content
    except requests.exceptions.HTTPError as e:
        logger.error(f"Perplexity API HTTP error: {e}")
        return f"[ERROR] Perplexity API: {e}"
    except requests.exceptions.Timeout:
        logger.error("Perplexity API timeout")
        return "[ERROR] Perplexity API timeout"
    except Exception as e:
        logger.error(f"Perplexity API error: {e}")
        return f"[ERROR] Perplexity API: {e}"


def generate_case_law_summary(address: str, docket_id: str) -> str:
    system_prompt = (
        "You are a CT real estate and foreclosure research assistant. "
        "Summarize key risks and timelines in under 300 words."
    )
    user_prompt = (
        f"Property: {address}\nDocket/Case ID: {docket_id}\n"
        "Summarize foreclosure status, likely timelines, and any CT-specific legal risks."
    )
    return perplexity_chat(system_prompt, user_prompt)


def generate_property_analysis(address: str, market_value: float, debt: float, equity: float) -> str:
    system_prompt = (
        "You are a CT real estate investment analyst. "
        "Provide a concise market analysis in under 200 words."
    )
    user_prompt = (
        f"Property: {address}\n"
        f"Estimated Market Value: ${market_value:,.0f}\n"
        f"Known Debt: ${debt:,.0f}\n"
        f"Estimated Equity: ${equity:,.0f}\n"
        "Analyze: neighborhood trends, comparable sales, investment potential, risks."
    )
    return perplexity_chat(system_prompt, user_prompt)


def generate_outreach_letters(owner_name: str, property_address: str, summary: str,
                               lender: str = "", court_date: str = "", years_at_property: int = 0,
                               equity_estimate: float = 0) -> str:
    system_prompt = (
        "You write warm, handwritten-style letters to distressed property owners. "
        "Tone: respectful, non-pushy, transparent about options."
    )
    user_prompt = (
        f"Owner: {owner_name}\n"
        f"Property: {property_address}\n"
        f"Lender: {lender}\n"
        f"Court Date: {court_date}\n"
        f"Years at Property: {years_at_property}\n"
        f"Estimated Cash Offer: ${equity_estimate:,.0f}\n"
        f"Summary: {summary}\n\n"
        "Write:\n"
        "1) A first-contact letter (200-300 words). Personalize with seller first name, property address, "
        "years at property, lender name, estimated equity/cash offer amount, court date. "
        "Maintain empathetic, non-pressure tone focused on offering a fresh start.\n\n"
        "2) A 7-day follow-up letter (200-300 words). Reference first letter timing, "
        "emphasize urgency of approaching court date, reinforce cash offer and clean break benefits.\n\n"
        "Each should fit on one page. Format for printing and mailing."
    )
    return perplexity_chat(system_prompt, user_prompt, max_tokens=3000)


logger.info("Perplexity client module loaded")
