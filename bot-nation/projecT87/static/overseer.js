/* Project 87 Overseer v5.2 — Frontend Logic */

'use strict';

const P87 = (() => {
  const STALE_THRESHOLD_MS = 120000;
  const POLL_INTERVAL_MS = 30000;
  const ACTIVITY_POLL_MS = 30000;

  let _state = {
    telemetry: null,
    activities: [],
    lastFetchTs: 0,
    consecutiveFails: 0,
    reduceMotion: false,
    selectedWallet: null,
    countdownInterval: null,
    nextCheckTs: null,
    overseerPowered: false,
    authToken: localStorage.getItem('authToken') || null,
    currentWallet: localStorage.getItem('walletAddress') || null,
  };

  // ── Init ─────────────────────────────────────────────────────────────────

  function init() {
    _state.reduceMotion = localStorage.getItem('p87_reduce_motion') === '1';
    _state.selectedWallet = localStorage.getItem('p87_selected_wallet') || null;

    if (_state.reduceMotion) document.body.classList.add('reduce-motion');

    _bindNav();
    _bindSettings();
    _bindWalletSelector();
    _initDomeScrollObserver();
    _bindUsdcRepairBtn();

    if (_state.authToken && _state.currentWallet) {
      // Already authenticated — check if wallet is activated before powering on
      _checkAuthAndPower();
    } else {
      _setPowered(false);
      _showModal();
    }

    setInterval(fetchTelemetry, POLL_INTERVAL_MS);
    setInterval(fetchActivity, ACTIVITY_POLL_MS);
    setInterval(_updateCountdowns, 1000);
  }

  // Check activation status then decide whether to power on automatically
  function _checkAuthAndPower() {
    fetch('/api/wallet/activation-status', {
      headers: { 'X-Auth-Token': _state.authToken || '', 'Content-Type': 'application/json' }
    })
      .then(function(r) {
        if (r.status === 401) { _setPowered(false); _showModal(); return null; }
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        if (data.activated) {
          _setPowered(true);
          _hideModal();
          fetchTelemetry();
          fetchActivity();
        } else {
          // Connected but not yet activated — show modal at signer phase
          _setPowered(false);
          _showModal();
          // Tell the modal UI to skip to signer phase
          if (typeof cmShowPhase === 'function') {
            cmShowPhase('signer');
            if (_state.currentWallet && typeof cmScanWbtcBalance === 'function') {
              cmScanWbtcBalance(_state.currentWallet);
            }
          }
        }
      })
      .catch(function() {
        _setPowered(false);
        _showModal();
      });
  }

  // ── Power state ──────────────────────────────────────────────────────────

  function _setPowered(on) {
    _state.overseerPowered = on;
    const scroll = document.getElementById('dome-scroll');
    if (on) {
      document.body.classList.remove('overseer--awaiting-wallet');
      scroll?.classList.remove('dome-scroll--hidden');
    } else {
      document.body.classList.add('overseer--awaiting-wallet');
      scroll?.classList.add('dome-scroll--hidden');
      _renderPoweredDownStrip();
    }
  }

  function _renderPoweredDownStrip() {
    _setText('strip-hf', 'HF: —');
    _setText('strip-eth', 'ETH: —');
    _setText('strip-countdown', 'T-MINUS: ----');
    _setText('strip-status', 'AWAITING CONNECT');
    _updateWalletBadge();
  }

  function _updateWalletBadge() {
    const badge = document.getElementById('strip-wallet-badge');
    if (!badge) return;
    if (_state.currentWallet) {
      badge.textContent = _state.currentWallet.slice(0,6) + '…' + _state.currentWallet.slice(-4);
    } else {
      badge.textContent = 'NO WALLET';
    }
  }

  function _showModal() {
    const modal = document.getElementById('connect-modal');
    if (modal) modal.classList.add('visible');
  }

  function _hideModal() {
    const modal = document.getElementById('connect-modal');
    if (modal) modal.classList.remove('visible');
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  function _bindNav() {
    document.querySelectorAll('.dome-nav-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        _closeAllOverlays();
        _scrollToDome(tile.dataset.dome);
      });
    });
    document.getElementById('nav-activity')?.addEventListener('click', () => {
      _closeAllOverlays();
      _toggleOverlay('activity-overlay');
      _renderActivityOverlay();
    });
    document.getElementById('nav-settings')?.addEventListener('click', () => {
      _closeAllOverlays();
      _toggleOverlay('settings-overlay');
    });
  }

  function _scrollToDome(domeId) {
    const el = document.getElementById(domeId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    _updateNavActive(domeId);
  }

  function _updateNavActive(domeId) {
    document.querySelectorAll('.dome-nav-tile').forEach(t => {
      t.classList.toggle('active', t.dataset.dome === domeId);
    });
  }

  function _initDomeScrollObserver() {
    const scroll = document.getElementById('dome-scroll');
    if (!scroll) return;
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) _updateNavActive(e.target.id); });
    }, { root: scroll, threshold: 0.55 });
    document.querySelectorAll('.dome-section').forEach(s => obs.observe(s));
  }

  function _toggleOverlay(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const isActive = el.classList.contains('active');
    _closeAllOverlays();
    if (!isActive) el.classList.add('active');
  }

  function _closeAllOverlays() {
    document.querySelectorAll('.overlay').forEach(o => o.classList.remove('active'));
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  function _bindSettings() {
    const toggle = document.getElementById('reduce-motion-toggle');
    if (!toggle) return;
    toggle.classList.toggle('on', _state.reduceMotion);
    toggle.addEventListener('click', () => {
      _state.reduceMotion = !_state.reduceMotion;
      localStorage.setItem('p87_reduce_motion', _state.reduceMotion ? '1' : '0');
      toggle.classList.toggle('on', _state.reduceMotion);
      document.body.classList.toggle('reduce-motion', _state.reduceMotion);
    });
  }

  // ── Wallet selector ───────────────────────────────────────────────────────

  function _bindWalletSelector() {
    const sel = document.getElementById('wallet-selector');
    if (!sel) return;
    sel.addEventListener('change', () => {
      _state.selectedWallet = sel.value || null;
      localStorage.setItem('p87_selected_wallet', _state.selectedWallet || '');
      if (_state.overseerPowered) {
        fetchTelemetry();
        fetchActivity();
      }
    });
  }

  function _bindUsdcRepairBtn() {
    const btn = document.getElementById('usdc-repair-btn');
    if (!btn) return;
    btn.addEventListener('click', async function() {
      if (typeof window.ethereum === 'undefined') {
        alert('No wallet found. Please connect MetaMask first.');
        return;
      }
      const botWallet = (typeof CONTRACTS !== 'undefined' && CONTRACTS.BOT_WALLET) ? CONTRACTS.BOT_WALLET : null;
      if (!botWallet || botWallet.length < 42) {
        alert('Bot wallet address not configured. Contact support.');
        return;
      }
      try {
        btn.textContent = 'WAITING FOR WALLET...';
        btn.disabled = true;

        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (!accounts || !accounts.length) throw new Error('No connected account found. Please reconnect your wallet.');

        const USDC_ADDR = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
        const spenderPadded = botWallet.toLowerCase().replace('0x', '').padStart(64, '0');
        const maxUint256 = 'f'.repeat(64);
        const calldata = '0x095ea7b3' + spenderPadded + maxUint256;

        const txHash = await window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from: accounts[0], to: USDC_ADDR, data: calldata }]
        });

        btn.textContent = 'CONFIRMING...';
        document.getElementById('usdc-repair-banner').style.display = 'none';
        console.log('[USDC Repair] approval tx sent:', txHash);
        setTimeout(fetchTelemetry, 4000);
      } catch(e) {
        btn.textContent = 'RE-APPROVE NOW';
        btn.disabled = false;
        console.error('[USDC Repair] approval failed:', e);
        if (e.code !== 4001) alert('Approval failed: ' + (e.message || e));
      }
    });
  }

  function _populateWalletSelector(wallets) {
    const sel = document.getElementById('wallet-selector');
    if (!sel || !wallets || !wallets.length) return;
    const current = _state.selectedWallet;
    sel.innerHTML = wallets.map(w =>
      `<option value="${w.wallet_address}" ${w.wallet_address === current ? 'selected' : ''}>
        ${w.wallet_address.slice(0,6)}…${w.wallet_address.slice(-4)}
       </option>`
    ).join('');
    if (!current) {
      _state.selectedWallet = wallets[0].wallet_address;
      localStorage.setItem('p87_selected_wallet', _state.selectedWallet);
    }
  }

  // ── HF color helper ───────────────────────────────────────────────────────

  function _hfClass(hf) {
    if (hf == null || hf === 0) return '';
    if (hf >= 3.40) return 'hf-safe';
    if (hf >= 2.40) return 'hf-warning';
    return 'hf-critical';
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  function fetchTelemetry() {
    if (!_state.overseerPowered) return;
    const qs = _state.selectedWallet ? `?wallet=${_state.selectedWallet}` : '';
    const headers = {};
    if (_state.authToken) headers['X-Auth-Token'] = _state.authToken;

    fetch(`/api/telemetry${qs}`, { headers })
      .then(r => r.json())
      .then(data => {
        _state.telemetry = data;
        _state.lastFetchTs = Date.now();
        _state.consecutiveFails = 0;
        _populateWalletSelector(data.wallets || []);
        const wallet = (data.wallets || [])[0] || {};
        _state.nextCheckTs = data.next_system_check_timestamp
          ? new Date(data.next_system_check_timestamp).getTime()
          : null;
        _state.nextRepayTs = data.next_repay_iso
          ? new Date(data.next_repay_iso).getTime()
          : null;
        _state.nextNurseTs = data.next_nurse_timestamp
          ? new Date(data.next_nurse_timestamp).getTime()
          : null;
        _render(wallet, data);
        _checkStale(data.last_updated_at);
        loadCyclePnl();
      })
      .catch(() => {
        _state.consecutiveFails++;
        if (_state.consecutiveFails >= 2) _showStaleDomes();
      });
  }

  function fetchActivity() {
    if (!_state.overseerPowered) return;
    const qs = _state.selectedWallet
      ? `?wallet=${_state.selectedWallet}&limit=10`
      : '?limit=10';
    const headers = {};
    if (_state.authToken) headers['X-Auth-Token'] = _state.authToken;

    fetch(`/api/activity${qs}`, { headers })
      .then(r => r.json())
      .then(data => {
        _state.activities = data.activities || [];
        _renderActivityFeed();
      })
      .catch(() => {});
  }

  // ── Cycle Intelligence ───────────────────────────────────────────────────

  async function loadCyclePnl() {
    if (!_state.overseerPowered) return;
    const wallet = _state.selectedWallet;
    if (!wallet) return;
    try {
      const res = await fetch(`/api/telemetry/cycle-pnl?wallet=${wallet}`);
      if (!res.ok) return;
      const d = await res.json();

      const eq  = d.equilibrium  || {};
      const pnl = d.cycle_pnl   || {};

      // Equilibrium card
      const isEq = eq.status === 'IN_EQUILIBRIUM';
      const badge = document.getElementById('ci-eq-status');
      if (badge) {
        badge.textContent = isEq ? 'IN EQUILIBRIUM' : 'ACTIVE';
        badge.className = 'ci-status-badge ' + (isEq ? 'ci-equilibrium' : 'ci-active');
      }
      if (!isEq && eq.time_to_floor_min != null) {
        const h = Math.floor(eq.time_to_floor_min / 60);
        const m = eq.time_to_floor_min % 60;
        _setText('ci-eq-countdown', `T-MINUS ${h}:${String(m).padStart(2, '0')}`);
        _setText('ci-eq-sub', `~${eq.cycles_to_floor} strategy cycles remaining`);
      } else if (isEq) {
        _setText('ci-eq-countdown', 'AT FLOOR');
        _setText('ci-eq-sub', `Awaiting +${eq.pct_appreciation_needed != null ? eq.pct_appreciation_needed : '--'}% market appreciation`);
      } else {
        _setText('ci-eq-countdown', 'T-MINUS --:--');
        _setText('ci-eq-sub', 'Calculating...');
      }

      // Breakout card
      const gap = eq.col_gap_usd != null ? eq.col_gap_usd : 0;
      if (gap > 0) {
        _setText('ci-breakout-amount', `$${gap.toFixed(2)}`);
        _setText('ci-breakout-pct', `${eq.pct_appreciation_needed != null ? eq.pct_appreciation_needed : '--'}% market appreciation equivalent`);
      } else {
        _setText('ci-breakout-amount', 'Not needed');
        _setText('ci-breakout-pct', 'HF above Capacity floor');
      }

      // PnL 24h
      _setText('ci-pnl-gross',  `$${(pnl.gross_usdc_24h  != null ? pnl.gross_usdc_24h  : 0).toFixed(2)}`);
      _setText('ci-pnl-repaid', `$${(pnl.repaid_usdc_24h != null ? pnl.repaid_usdc_24h : 0).toFixed(2)}`);
      _setText('ci-pnl-net',    `$${(pnl.net_usdc_24h    != null ? pnl.net_usdc_24h    : 0).toFixed(2)}`);

      // Last cycle summary line
      const lc = pnl.last_cycle;
      if (lc) {
        const netSign = lc.net_usdc >= 0 ? '+' : '';
        _setText('ci-last-cycle-line',
          `Last cycle: ${netSign}$${lc.net_usdc.toFixed(2)} USDC over ${lc.elapsed_min} min`);
      } else {
        _setText('ci-last-cycle-line', '');
      }

      // 10-event forecast
      const fc = pnl.forecast_10_events || {};
      _setText('ci-fc-gross',  `$${(fc.gross  != null ? fc.gross  : 0).toFixed(2)}`);
      _setText('ci-fc-repaid', `$${(fc.repaid != null ? fc.repaid : 0).toFixed(2)}`);
      _setText('ci-fc-net',    `$${(fc.net    != null ? fc.net    : 0).toFixed(2)}`);
      _setText('ci-fc-time',    fc.time_min != null ? `~${fc.time_min} min at current pace` : '');

    } catch (e) {
      console.warn('[CycleIntel] fetch error', e);
    }
  }

  // ── Stale data ────────────────────────────────────────────────────────────

  function _checkStale(lastUpdatedAt) {
    if (!lastUpdatedAt) return;
    const ageMs = Date.now() - new Date(lastUpdatedAt).getTime();
    const banner = document.getElementById('stale-banner');
    if (ageMs > STALE_THRESHOLD_MS) {
      if (banner) banner.style.display = 'block';
      _showStaleDomes();
    } else {
      if (banner) banner.style.display = 'none';
      document.querySelectorAll('.dome-shell').forEach(d => d.classList.remove('dome-stale'));
    }
  }

  function _showStaleDomes() {
    document.getElementById('stale-banner').style.display = 'block';
    document.querySelectorAll('.dome-shell').forEach(d => d.classList.add('dome-stale'));
    _setText('d3-countdown', 'T-MINUS --:--');
  }

  // ── Bottom dock nav tiles ─────────────────────────────────────────────────

  function _renderNavTiles(wallet, fullData) {
    const hfNull = wallet.health_factor == null;
    const hf = hfNull ? null : wallet.health_factor;
    const pathMin = wallet.path_min_hf || 3.40;

    // OPS tile: HF
    const opsM = document.getElementById('tile-ops-metric');
    const opsD = document.getElementById('tile-ops-dot');
    if (opsM) opsM.textContent = hfNull ? 'HF --' : `HF ${hf.toFixed(2)}`;
    if (opsD) opsD.className = 'dome-nav-tile-dot ' + (hfNull ? 'critical' : hf >= pathMin + 0.5 ? 'ok' : hf >= pathMin ? 'warning' : 'critical');

    // INFRA tile: ETH balance
    const infraM = document.getElementById('tile-infra-metric');
    const infraD = document.getElementById('tile-infra-dot');
    const eth = (fullData.operator_wallet || {}).eth_balance || 0;
    if (infraM) infraM.textContent = `${eth.toFixed(3)} ETH`;
    if (infraD) { const gr = (fullData.operator_wallet || {}).gas_reserve_eth || 1.0; infraD.className = 'dome-nav-tile-dot ' + (eth >= gr ? 'ok' : eth >= gr * 0.5 ? 'warning' : 'critical'); }

    // ECON tile: USDC
    const econM = document.getElementById('tile-econ-metric');
    const econD = document.getElementById('tile-econ-dot');
    const usdc = wallet.user_usdc_balance || 0;
    if (econM) econM.textContent = `$${usdc.toFixed(2)}`;
    if (econD) econD.className = 'dome-nav-tile-dot ' + (usdc > 50 ? 'ok' : usdc > 10 ? 'warning' : 'critical');

    // SENTINEL tile: growth likelihood
    const sentM = document.getElementById('tile-sentinel-metric');
    const sentD = document.getElementById('tile-sentinel-dot');
    const pct = wallet.growth_likelihood_pct || 50;
    if (sentM) sentM.textContent = `${pct.toFixed(0)}%`;
    if (sentD) sentD.className = 'dome-nav-tile-dot ' + (pct >= 70 ? 'ok' : pct >= 30 ? 'warning' : 'critical');

    // INTEL tile: T-MINUS countdown
    const intelM = document.getElementById('tile-intel-metric');
    const intelD = document.getElementById('tile-intel-dot');
    if (intelM) {
      const remaining = _state.nextCheckTs ? Math.max(0, Math.floor((_state.nextCheckTs - Date.now()) / 1000)) : null;
      if (remaining !== null) {
        const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
        const ss = String(remaining % 60).padStart(2, '0');
        intelM.textContent = `T-${mm}:${ss}`;
      } else {
        intelM.textContent = 'T---:--';
      }
    }
    if (intelD) intelD.className = 'dome-nav-tile-dot ok';
  }



  // ── Main render ───────────────────────────────────────────────────────────

  function _render(wallet, fullData) {
    _renderDome1(wallet);
    _renderDome2(wallet);
    _renderDome3(fullData);
    _renderDome4(wallet);
    _renderDome5(fullData);
    _renderStripHeader(wallet, fullData);
    _renderNavTiles(wallet, fullData);
    _renderHexOverlay(wallet, fullData);
    _checkBeamTriggers(wallet, fullData, _state.activities);
  }

  // ── Dome 1: Safety ────────────────────────────────────────────────────────

  function _renderDome1(w) {
    const hfNull = w.health_factor == null;
    const hf = hfNull ? 0 : w.health_factor;
    const shield = w.shield_status || 'DOWN';
    const strategy = (w.strategy_label || 'IDLE').toLowerCase();
    const pathMin = w.path_min_hf || 3.40;

    _setText('d1-hf', hfNull ? '--' : hf.toFixed(2));
    const collNull = w.total_collateral_usd == null || w.total_debt_usd == null;
    _setText('d1-collateral', collNull ? '$-- / $--' : `$${_fmt(w.total_collateral_usd)} / $${_fmt(w.total_debt_usd)}`);
    _setStrategyBadge('d1-strategy-badge', w.strategy_label || 'IDLE');
    _setShieldIndicator('d1-shield', shield);

    const ring = document.getElementById('d1-ring-fill');
    if (ring) {
      const pct = Math.min(hf / 6.0, 1.0);
      const circ = 2 * Math.PI * 90;
      ring.style.strokeDasharray = circ;
      ring.style.strokeDashoffset = circ * (1 - pct);

      ring.classList.remove('amber', 'red', 'pulse-red');
      if (hf < 2.40) {
        ring.classList.add('red');
        if (!_state.reduceMotion) ring.classList.add('pulse-red');
      } else if (hf < 3.40) {
        ring.classList.add('amber');
      }
    }

    const hfEl = document.getElementById('d1-hf');
    if (hfEl) {
      hfEl.classList.remove('hf-safe', 'hf-warning', 'hf-critical');
      const hfCls = _hfClass(hf);
      if (hfCls) hfEl.classList.add(hfCls);
    }

    const shell = document.getElementById('d1-shell');
    if (shell) {
      shell.className = 'dome-shell';
      if (shield === 'DOWN') shell.classList.add('shield-down');
      else if (shield === 'AWARE') shell.classList.add('shield-aware');
    }

    const repairBanner = document.getElementById('usdc-repair-banner');
    if (repairBanner) {
      const needsRepair = w.usdc_bot_approved === false;
      repairBanner.style.display = needsRepair ? 'flex' : 'none';
    }
  }

  function _setShieldIndicator(id, status) {
    const el = document.getElementById(id);
    if (!el) return;
    const cls = status === 'ACTIVE' ? 'active' : status === 'AWARE' ? 'aware' : 'down';
    el.className = `shield-indicator ${cls}`;
    const textEl = el.querySelector('.shield-text');
    if (textEl) textEl.textContent = `SHIELD: ${status}`;
  }

  function _setStrategyBadge(id, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = label;
    el.className = 'strategy-badge ' + (label || 'idle').toLowerCase();
  }

  // ── Dome 2: USDC Reactor ──────────────────────────────────────────────────

  function _renderDome2(w) {
    const usdc = w.user_usdc_balance || 0;
    const earned = w.usdc_earned_last_24h || 0;
    const repaid = w.usdc_repaid_last_24h || 0;

    _setText('d2-usdc', `$${usdc.toFixed(2)}`);
    _setText('d2-earned', `+$${earned.toFixed(2)} earned`);
    _setText('d2-repaid', `-$${repaid.toFixed(2)} repaid`);

    const tankFill = document.getElementById('d2-tank-fill');
    if (tankFill) {
      const pct = Math.min(usdc / 100.0, 1.0);
      const maxH = 80;
      const fillH = pct * maxH;
      const fillY = 8 + (maxH - fillH);
      tankFill.setAttribute('y', fillY);
      tankFill.setAttribute('height', fillH);
      tankFill.setAttribute('fill', usdc > 50 ? '#00e5ff' : usdc > 20 ? '#ffb000' : '#ff2020');
    }

    const earnedFill = document.getElementById('d2-earned-bar');
    if (earnedFill) earnedFill.style.width = `${Math.min(earned / 3.60 * 100, 100)}%`;

    const repaidFill = document.getElementById('d2-repaid-bar');
    if (repaidFill) repaidFill.style.width = `${Math.min(repaid / 3.60 * 100, 100)}%`;

    _renderYieldSpread(w);
  }

  function _renderYieldSpread(w) {
    const bc = w.borrow_cost_apy_pct;
    const ey = w.engine_yield_apy_pct_7d;
    const nev = w.net_economic_velocity_pct;
    const sep = '<span class="yield-spread-sep"> | </span>';

    const bcStr = bc != null ? `Borrow Cost: ${bc.toFixed(2)}%` : `Borrow Cost: N/A`;
    const eyStr = ey != null ? `Engine Yield: +${ey.toFixed(2)}%` : `Engine Yield: N/A`;

    let nevStr;
    if (nev === null || nev === undefined) {
      nevStr = `<span class="nev-null">NET PROFITABILITY: N/A</span>`;
    } else if (nev > 0) {
      nevStr = `<span class="nev-positive">NET PROFITABILITY: +${nev.toFixed(2)}%</span>`;
    } else {
      nevStr = `<span class="nev-negative">NON-PROFITABLE: ${nev.toFixed(2)}%</span>`;
    }

    const el = document.getElementById('d2-yield-spread');
    if (el) el.innerHTML = `${bcStr}${sep}${eyStr}${sep}${nevStr}`;
  }

  // ── Dome 3: Mission Time ──────────────────────────────────────────────────

  function _renderDome3(data) {
    if (!_state.nextCheckTs) {
      _setText('d3-countdown', 'T-MINUS --:--');
    }
    _renderMilestones(data.wallets && data.wallets[0] ? data.wallets[0].milestones : []);
    _renderArcs(data);
  }

  function _renderArcs(data) {
    const now = Date.now();
    const intervals = { core: 2 * 60000, repay: 18 * 60000, nurse: 5 * 60000 };
    const arcIds = { core: 'd3-arc-core', repay: 'd3-arc-repay', nurse: 'd3-arc-nurse' };
    const nextTimes = {
      core: _state.nextCheckTs || null,
      repay: _state.nextRepayTs || null,
      nurse: _state.nextNurseTs || null,
    };

    Object.entries(arcIds).forEach(([key, arcId]) => {
      const arc = document.getElementById(arcId);
      if (!arc) return;
      const interval = intervals[key];
      const nextTime = nextTimes[key];
      let pct = 0;
      if (nextTime) {
        const elapsed = interval - (nextTime - now);
        pct = Math.max(0, Math.min(elapsed / interval, 1.0));
      }
      const r = parseInt(arc.getAttribute('data-r') || '70');
      const circ = 2 * Math.PI * r;
      arc.style.strokeDasharray = circ;
      arc.style.strokeDashoffset = circ * (1 - pct);
      const remaining = nextTime ? (nextTime - now) / 1000 : Infinity;
      arc.style.stroke = remaining < 30 && !_state.reduceMotion ? '#ffb000' : '';
    });
  }

  function _renderMilestones(milestones) {
    if (!milestones || !milestones.length) return;
    milestones.slice(0, 3).forEach((m, i) => {
      const el = document.getElementById(`d3-milestone-${i}`);
      if (!el) return;
      const pct = parseFloat(m.percentage_complete || 0).toFixed(1);
      const target = parseFloat(m.target_usdc || 0);
      el.innerHTML = `$${_formatK(target)} — <span class="milestone-pct">${pct}%</span> complete`;
    });
  }

  // ── Dome 4: Strategy Sentiment ────────────────────────────────────────────
  // All values derived live from /api/telemetry → growth_likelihood_pct

  function _renderDome4(w) {
    const rawPct = w.growth_likelihood_pct;
    const isCalibrating = (rawPct == null);
    const pct = isCalibrating ? 50 : Number(rawPct);

    // ── Zone classification ──────────────────────────────────────────────────
    const label     = pct >= 70 ? 'BULLISH' : pct >= 30 ? 'NEUTRAL' : 'BEARISH';
    const zoneCls   = pct >= 70 ? 'bullish' : pct >= 30 ? 'neutral'  : 'bearish';
    const zoneColor = pct >= 70 ? '#00e5ff' : pct >= 30 ? '#ffb000'  : '#ff2020';

    // ── Center readout ───────────────────────────────────────────────────────
    _setText('d4-likelihood-pct', isCalibrating ? '--' : `${pct.toFixed(0)}%`);
    const labelEl = document.getElementById('d4-sentiment-label');
    if (labelEl) {
      labelEl.textContent = isCalibrating ? 'CALIBRATING...' : label;
      labelEl.className   = isCalibrating ? 'sw-label sw-calibrating' : `sw-label ${zoneCls}`;
    }

    // ── Needle rotation ──────────────────────────────────────────────────────
    // Formula: needle_deg = (pct / 100) × 360
    //   0% → 0° (12 o'clock / start of BEARISH zone)
    //  30% → 108° (boundary BEARISH→NEUTRAL)
    //  70% → 252° (boundary NEUTRAL→BULLISH)
    // 100% → 360° (back to 12 o'clock, full sweep)
    const needle_deg = (pct / 100) * 360;
    const needle = document.getElementById('d4-needle');
    if (needle) needle.style.transform = `rotate(${needle_deg}deg)`;

    // ── Active sweep arc (shows filled portion from 0% to current pct) ───────
    // Formula: arc_len = (pct / 100) × circumference
    //   circumference = 2π × r = 2π × 72 ≈ 452.39
    const CIRC    = 452.39;
    const arc_len = (pct / 100) * CIRC;
    const arcActive = document.getElementById('d4-arc-active');
    if (arcActive) {
      arcActive.setAttribute('stroke-dasharray', `${arc_len.toFixed(2)} ${CIRC}`);
      arcActive.style.stroke = zoneColor;
    }

    // ── Growth / Defensive sub-indicators ───────────────────────────────────
    // Growth engine intensity:   g = x / 100   (increases toward BULLISH)
    // Defensive posture:         d = (100 − x) / 100   (increases toward BEARISH)
    // Both displayed with formula labels in the DOM (see sw-ind-formula elements)
    const growth_intensity    = pct / 100;           // 0.0 → 1.0
    const defensive_intensity = (100 - pct) / 100;   // 1.0 → 0.0

    const gBar = document.getElementById('d4-growth-bar');
    if (gBar) {
      gBar.style.width   = `${pct}%`;
      gBar.style.opacity = (0.30 + growth_intensity * 0.70).toFixed(2);
    }

    const dBar = document.getElementById('d4-defensive-bar');
    if (dBar) {
      dBar.style.width   = `${(100 - pct)}%`;
      dBar.style.opacity = (0.30 + defensive_intensity * 0.70).toFixed(2);
    }

    _renderActivityFeed();
  }

  function _renderActivityFeed() {
    const feed = document.getElementById('d4-activity-feed');
    if (!feed) return;
    feed.innerHTML = _state.activities.slice(0, 10).map(a => {
      const ts = a.created_at ? new Date(a.created_at).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '';
      const summary = a.details_summary || a.action_type || '';
      const severityCls = a.severity || 'info';
      const shieldTagged = summary.startsWith('[SHIELD DEPLOYED]')
        ? summary.replace('[SHIELD DEPLOYED]', `<span class="shield-tag">[SHIELD DEPLOYED]</span>`)
        : summary;
      return `<div class="feed-row ${severityCls}">[${ts}] ${a.action_type} — ${shieldTagged}</div>`;
    }).join('');
  }

  // ── Dome 5: Operator Bay ──────────────────────────────────────────────────

  function _renderDome5(data) {
    const op = data.operator_wallet || {};
    const ethBal = op.eth_balance || 0;
    const gasReserve = op.gas_reserve_eth || 1.0;
    const ratio = ethBal / gasReserve;

    const statusLabel = ratio >= 1.0 ? 'FUEL: OK' : ratio >= 0.5 ? 'FUEL: LOW' : 'FUEL: CRITICAL';
    const statusCls = ratio >= 1.0 ? 'ok' : ratio >= 0.5 ? 'low' : 'critical';

    _setText('d5-eth-balance', `${ethBal.toFixed(4)} ETH`);
    const statusEl = document.getElementById('d5-gauge-status');
    if (statusEl) { statusEl.textContent = statusLabel; statusEl.className = `gauge-status ${statusCls}`; }

    const pointer = document.getElementById('d5-gauge-pointer');
    if (pointer) {
      const angle = Math.min(ratio, 2.0) * 90;
      pointer.style.transform = `rotate(${angle}deg)`;
    }

    const arcFill = document.getElementById('d5-gauge-arc');
    if (arcFill) {
      const r = 60;
      const circ = Math.PI * r;
      arcFill.style.strokeDasharray = circ;
      arcFill.style.strokeDashoffset = circ * (1 - Math.min(ratio / 2.0, 1.0));
      arcFill.style.stroke = ratio >= 1.0 ? '#00ff88' : ratio >= 0.5 ? '#ffb000' : '#ff2020';
    }

    const lastNurse = op.last_nurse_at;
    const nurseEl = document.getElementById('d5-nurse-row');
    if (nurseEl && lastNurse) {
      const nurseTime = new Date(lastNurse).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'});
      nurseEl.textContent = `Last sweep: ${nurseTime}`;
    }
  }

  // ── Countdowns ────────────────────────────────────────────────────────────

  function _fmtCountdown(tsMs) {
    if (!tsMs) return '--:--';
    const remaining = Math.max(0, Math.floor((tsMs - Date.now()) / 1000));
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function _countdownColor(tsMs) {
    if (!tsMs) return '';
    const sec = Math.max(0, Math.floor((tsMs - Date.now()) / 1000));
    if (sec <= 10) return '#ff2020';
    if (sec <= 60) return '#ffb000';
    return '#00e5ff';
  }

  function _updateCountdowns() {
    if (!_state.overseerPowered) return;

    const ageMs = Date.now() - _state.lastFetchTs;
    const isStale = _state.lastFetchTs > 0 && ageMs > STALE_THRESHOLD_MS;

    if (isStale) {
      _setText('d3-countdown', 'T-MINUS --:--');
      _setText('strip-countdown', 'T---:--');
      ['sched-core-timer', 'sched-nurse-timer', 'sched-repay-timer'].forEach(id => _setText(id, '--:--'));
      return;
    }

    const now = Date.now();

    if (_state.nextCheckTs) {
      const remaining = Math.max(0, Math.floor((_state.nextCheckTs - now) / 1000));
      const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
      const ss = String(remaining % 60).padStart(2, '0');
      const countStr = `T-MINUS ${mm}:${ss}`;
      _setText('d3-countdown', countStr);
      _setText('strip-countdown', `T-${mm}:${ss}`);
      const intelM = document.getElementById('tile-intel-metric');
      if (intelM) intelM.textContent = `T-${mm}:${ss}`;
      const coreEl = document.getElementById('sched-core-timer');
      if (coreEl) {
        coreEl.textContent = `${mm}:${ss}`;
        coreEl.style.color = _countdownColor(_state.nextCheckTs);
      }
    }

    if (_state.nextNurseTs) {
      const nurseEl = document.getElementById('sched-nurse-timer');
      if (nurseEl) {
        nurseEl.textContent = _fmtCountdown(_state.nextNurseTs);
        nurseEl.style.color = _countdownColor(_state.nextNurseTs);
      }
    }

    if (_state.nextRepayTs) {
      const repayEl = document.getElementById('sched-repay-timer');
      if (repayEl) {
        repayEl.textContent = _fmtCountdown(_state.nextRepayTs);
        repayEl.style.color = _countdownColor(_state.nextRepayTs);
      }
    }
  }

  // ── Top strip ─────────────────────────────────────────────────────────────

  function _renderStripHeader(wallet, data) {
    const hfNull = wallet.health_factor == null;
    const hf = hfNull ? 0 : wallet.health_factor;
    _setText('strip-hf', hfNull ? 'HF: --' : `HF: ${hf.toFixed(2)}`);
    const stripHfEl = document.getElementById('strip-hf');
    if (stripHfEl) {
      stripHfEl.classList.remove('hf-safe', 'hf-warning', 'hf-critical');
      const shfCls = _hfClass(hf);
      if (shfCls && !hfNull) stripHfEl.classList.add(shfCls);
    }
    const dotEl = document.getElementById('strip-hf-dot');
    if (dotEl) {
      const dotCls = hfNull ? 'critical' : hf >= 3.60 ? 'ok' : hf >= 3.20 ? 'warning' : 'critical';
      dotEl.className = `strip-dot ${dotCls}`;
    }
    const ethBal = data.operator_wallet ? data.operator_wallet.eth_balance || 0 : 0;
    const ethStatus = ethBal >= 1.0 ? 'ETH: OK' : ethBal >= 0.5 ? 'ETH: LOW' : 'ETH: CRIT';
    _setText('strip-eth', ethStatus);

    const shield = wallet.shield_status || 'DOWN';
    _setText('strip-status', `SHIELD: ${shield}`);
    const statusEl = document.getElementById('strip-status');
    if (statusEl) {
      statusEl.style.color = shield === 'ACTIVE' ? '#00ff88' : shield === 'AWARE' ? '#ffb000' : '#ff2020';
    }

    _updateWalletBadge();
  }

  // ── Hex overview ──────────────────────────────────────────────────────────

  function _renderHexOverlay(wallet, data) {
    const domes = [
      { name: 'SAFETY', metric: wallet.health_factor != null ? `HF ${wallet.health_factor.toFixed(2)}` : 'HF --', status: _hfStatus(wallet.health_factor || 0, wallet.path_min_hf || 3.40), dome: 0 },
      { name: 'REACTOR', metric: `$${(wallet.user_usdc_balance || 0).toFixed(2)}`, status: 'ok', dome: 1 },
      { name: 'MISSION', metric: 'T-TIME', status: 'ok', dome: 2 },
      { name: 'SENTIMENT', metric: `${(wallet.growth_likelihood_pct || 50).toFixed(0)}%`, status: _sentimentStatus(wallet.growth_likelihood_pct || 50), dome: 3 },
      { name: 'OPERATOR', metric: `${(data.operator_wallet?.eth_balance || 0).toFixed(3)}E`, status: _ethStatus(data.operator_wallet?.eth_balance || 0), dome: 4 },
    ];

    const row1 = document.getElementById('hex-row-1');
    const row2 = document.getElementById('hex-row-2');
    const row3 = document.getElementById('hex-row-3');
    if (!row1) return;

    const makeHex = (d) => `
      <div class="hex-cell" data-dome="${d.dome}">
        <div class="hex-name">${d.name}</div>
        <div class="hex-metric">${d.metric}</div>
        <div class="hex-dot ${d.status}"></div>
      </div>`;

    row1.innerHTML = makeHex(domes[0]) + makeHex(domes[1]);
    row2.innerHTML = makeHex(domes[2]);
    row3.innerHTML = makeHex(domes[3]) + makeHex(domes[4]);

    document.querySelectorAll('.hex-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const domeIdx = parseInt(cell.dataset.dome || 0);
        _closeAllOverlays();
        _scrollToDome(domeIdx);
      });
    });
  }

  // ── Activity overlay ──────────────────────────────────────────────────────

  function _renderActivityOverlay() {
    const qs = _state.selectedWallet ? `?wallet=${_state.selectedWallet}&limit=50` : '?limit=50';
    const headers = {};
    if (_state.authToken) headers['X-Auth-Token'] = _state.authToken;
    fetch(`/api/activity${qs}`, { headers })
      .then(r => r.json())
      .then(data => {
        const list = document.getElementById('activity-overlay-list');
        if (!list) return;
        const acts = data.activities || [];
        list.innerHTML = acts.map(a => {
          const ts = a.created_at ? new Date(a.created_at).toLocaleString() : '';
          const summary = a.details_summary || a.action_type || '';
          const shieldTagged = summary.startsWith('[SHIELD DEPLOYED]')
            ? summary.replace('[SHIELD DEPLOYED]', `<span class="shield-tag">[SHIELD DEPLOYED]</span>`)
            : summary;
          return `
            <div class="activity-item">
              <div class="activity-item-header">
                <span class="sev-dot ${a.severity || 'info'}"></span>
                <span class="action-type">${a.action_type}</span>
                <span class="timestamp">${ts}</span>
              </div>
              <div class="summary">${shieldTagged}</div>
            </div>`;
        }).join('');
      })
      .catch(() => {});
  }

  // ── T016: Cross-dome data beams ───────────────────────────────────────────

  let _beamSvg = null;
  let _prevActivities = [];
  let _prevLikelihoodPct = 50;
  let _prevMilestonePcts = [];

  function _getBeamSvg() {
    if (_beamSvg) return _beamSvg;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', 'beam-overlay');
    svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:90;overflow:visible;';
    document.body.appendChild(svg);
    _beamSvg = svg;
    return svg;
  }

  function _getDomeCollarCenter(domeId) {
    const scroll = document.getElementById('dome-scroll');
    const shell = document.querySelector(`#${domeId} .dome-shell`);
    if (!shell || !scroll) return null;
    const r = shell.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.bottom - 6
    };
  }

  function _fireBeam(fromDomeId, toDomeId, strokeColor, duration) {
    if (_state.reduceMotion) return;
    const svg = _getBeamSvg();
    const from = _getDomeCollarCenter(fromDomeId);
    const to = _getDomeCollarCenter(toDomeId);
    if (!from || !to) return;

    const cx1 = from.x + (to.x - from.x) * 0.25;
    const cy1 = from.y + 40;
    const cx2 = from.x + (to.x - from.x) * 0.75;
    const cy2 = to.y + 40;
    const d = `M${from.x},${from.y} C${cx1},${cy1} ${cx2},${cy2} ${to.x},${to.y}`;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', strokeColor);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-opacity', '0.7');

    const pathLen = 500;
    const dashLen = 8;
    const gapLen = 12;
    path.style.strokeDasharray = `${dashLen} ${gapLen}`;
    path.style.strokeDashoffset = pathLen;
    path.style.transition = `stroke-dashoffset ${duration}ms linear`;

    svg.appendChild(path);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        path.style.strokeDashoffset = -pathLen;
      });
    });

    setTimeout(() => {
      if (svg.contains(path)) svg.removeChild(path);
    }, duration + 200);
  }

  function _checkBeamTriggers(wallet, data, activities) {
    if (_state.reduceMotion) return;

    if (!_prevActivities.length && activities.length) {
      _prevActivities = activities.map(a => a.id);
    }

    const newActivities = activities.filter(a => !_prevActivities.includes(a.id));
    _prevActivities = activities.map(a => a.id);

    for (const act of newActivities) {
      if (act.action_type === 'REPAY_EXECUTED') {
        _fireBeam('dome-2', 'dome-1', '#00e5ff', 800);
      }
      if (act.action_type === 'NURSE_SWEEP_COMPLETE' || act.action_type === 'NURSE_SWEEP') {
        _fireBeam('dome-5', 'dome-1', '#00ff88', 900);
      }
    }

    const milestones = wallet.milestones || [];
    const currentPcts = milestones.map(m => parseFloat(m.percentage_complete || 0));
    if (_prevMilestonePcts.length) {
      for (let i = 0; i < currentPcts.length; i++) {
        const prev = _prevMilestonePcts[i] || 0;
        const cur = currentPcts[i];
        if (Math.floor(cur / 10) > Math.floor(prev / 10)) {
          _fireBeam('dome-2', 'dome-3', '#ffb000', 700);
          break;
        }
      }
    }
    _prevMilestonePcts = currentPcts;

    const likelihood = wallet.growth_likelihood_pct || 50;
    if (_prevLikelihoodPct < 70 && likelihood >= 70) {
      _fireBeam('dome-4', 'dome-3', '#00ff88', 750);
    }
    _prevLikelihoodPct = likelihood;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function _fmt(val) {
    if (val == null) return '--';
    return parseFloat(val).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  }

  function _formatK(val) {
    if (val >= 1000) return (val / 1000).toFixed(0) + 'K';
    return val.toFixed(0);
  }

  function _hfStatus(hf, pathMin) {
    if (hf < 3.20) return 'critical';
    if (hf < pathMin) return 'warning';
    return 'ok';
  }

  function _sentimentStatus(pct) {
    return pct >= 70 ? 'ok' : pct >= 30 ? 'warning' : 'critical';
  }

  function _ethStatus(eth) {
    return eth >= 1.0 ? 'ok' : eth >= 0.5 ? 'warning' : 'critical';
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Called by the auth bridge (overseer.html inline script) after a successful
   * /api/auth/wallet response. Stores credentials in state + localStorage.
   */
  function onWalletConnected(token, wallet) {
    _state.authToken = token;
    _state.currentWallet = wallet;
    _state.selectedWallet = wallet;
    localStorage.setItem('authToken', token);
    localStorage.setItem('walletAddress', wallet);
    localStorage.setItem('p87_selected_wallet', wallet);
    _updateWalletBadge();
  }

  /**
   * Called once the user clicks "LAUNCH OVERSEER" (after activation confirmed).
   * Powers on the domes, hides the modal, starts telemetry polling.
   */
  function powerOn() {
    _setPowered(true);
    _hideModal();
    _scrollToDome('dome-ops');
    fetchTelemetry();
    fetchActivity();
  }

  /**
   * Called by eject / hard-reset to wipe all auth state.
   */
  function onWalletEjected() {
    _state.authToken = null;
    _state.currentWallet = null;
    _state.selectedWallet = null;
    _state.overseerPowered = false;
    localStorage.removeItem('authToken');
    localStorage.removeItem('walletAddress');
    localStorage.removeItem('p87_selected_wallet');
    _setPowered(false);
    _showModal();
  }

  /**
   * Expose auth token to the inline auth script via a getter so the bridge
   * never needs to reach directly into _state.
   */
  function _getAuthToken() {
    return _state.authToken;
  }

  /**
   * Opens the connection modal (settings button, wallet badge).
   */
  function showModal() {
    _showModal();
  }

  return {
    init,
    showModal,
    powerOn,
    onWalletConnected,
    onWalletEjected,
    _getAuthToken,
  };
})();

document.addEventListener('DOMContentLoaded', P87.init);
