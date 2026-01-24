// ==UserScript==
// @name         StayValue
// @namespace    https://github.com/chaoxu/stayvalue
// @version      1.16.0
// @description  Compare hotel point rates vs cash rates - shows cents-per-point (cpp) and highlights better value
// @match        https://www.ihg.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // USER CONFIGURATION
    // ============================================
    // User-configurable values (can be changed via Tampermonkey menu)
    const USER_CONFIG = {
        pointValue: GM_getValue('pointValue', 0.5),           // cents per point valuation
        cashbackRate: GM_getValue('cashbackRate', 0.05),      // % cashback on total price
        travelAgentRebateRate: GM_getValue('travelAgentRebateRate', 0.07),  // % rebate on room rate
        dollarDecimals: GM_getValue('dollarDecimals', 0),     // decimal places for dollar amounts (0, 1, or 2)
        iataCode: GM_getValue('iataCode', '')                 // IATA code for travel agent tracking
    };

    const CONFIG = {
        IHG: {
            // Base points per dollar by brand (default 10, some brands earn less)
            brandBasePoints: {
                'default': 10,
                'CDLW': 5,    // Candlewood Suites
                'STAY': 5     // Staybridge Suites
            },
            // Elite bonus rate (multiplier on top of base points)
            // Formula: points = roomRate * brandBasePoints * (1 + eliteBonusRate)
            eliteBonusRate: {
                'CLUB': 0,        // 10x (base only)
                'SILVER': 0.2,    // 12x
                'GOLD': 0.4,      // 14x
                'PLATINUM': 0.6,  // 16x
                'DIAMOND': 1.0    // 20x (2x base)
            },
            defaultEliteStatus: 'DIAMOND',  // Used if not logged in or status unknown
            // Rate plans that offer bonus points
            bonusPointsRates: {
                'IKBIZ': 1000,
                'IKPCM': 1000,
                'IKME3': 1000,
                'IKME4': 1000,
                'IKME6': 2000,
                'IKME7': 2000,
                'IKME8': 3000,
                'IKME9': 3000,
                'IKM5K': 5000
            }
        },
        // Debug mode - set to true to see console logs
        debug: true  // Enabled for initial testing
    };

    // ============================================
    // MENU COMMANDS FOR USER CONFIGURATION
    // ============================================
    function setupMenuCommands() {
        GM_registerMenuCommand(`Set Point Value (current: ${USER_CONFIG.pointValue}¢)`, () => {
            const value = prompt('Enter your point valuation in cents (e.g., 0.5 for half a cent):', USER_CONFIG.pointValue);
            if (value !== null) {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 0) {
                    GM_setValue('pointValue', num);
                    alert(`Point value set to ${num}¢. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter a number >= 0.');
                }
            }
        });

        GM_registerMenuCommand(`Set Cashback Rate (current: ${(USER_CONFIG.cashbackRate * 100).toFixed(1)}%)`, () => {
            const value = prompt('Enter your cashback rate as a percentage (e.g., 5 for 5%):', USER_CONFIG.cashbackRate * 100);
            if (value !== null) {
                const num = parseFloat(value) / 100;
                if (!isNaN(num) && num >= 0 && num <= 1) {
                    GM_setValue('cashbackRate', num);
                    alert(`Cashback rate set to ${(num * 100).toFixed(1)}%. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter a percentage between 0 and 100.');
                }
            }
        });

        GM_registerMenuCommand(`Set Travel Agent Rebate (current: ${(USER_CONFIG.travelAgentRebateRate * 100).toFixed(1)}%)`, () => {
            const value = prompt('Enter travel agent rebate rate as a percentage (e.g., 7 for 7%, 0 to disable):', USER_CONFIG.travelAgentRebateRate * 100);
            if (value !== null) {
                const num = parseFloat(value) / 100;
                if (!isNaN(num) && num >= 0 && num <= 1) {
                    GM_setValue('travelAgentRebateRate', num);
                    alert(`Travel agent rebate set to ${(num * 100).toFixed(1)}%. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter a percentage between 0 and 100.');
                }
            }
        });

        GM_registerMenuCommand(`Set Dollar Decimals (current: ${USER_CONFIG.dollarDecimals})`, () => {
            const value = prompt('Enter number of decimal places for dollar amounts (0, 1, or 2):', USER_CONFIG.dollarDecimals);
            if (value !== null) {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num >= 0 && num <= 2) {
                    GM_setValue('dollarDecimals', num);
                    alert(`Dollar decimals set to ${num}. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter 0, 1, or 2.');
                }
            }
        });

        GM_registerMenuCommand(`Set IATA Code (current: ${USER_CONFIG.iataCode || 'not set'})`, () => {
            const value = prompt('Enter your IATA code (e.g., 99634986):', USER_CONFIG.iataCode);
            if (value !== null) {
                const trimmed = value.trim();
                if (trimmed.length <= 8) {
                    GM_setValue('iataCode', trimmed);
                    alert(`IATA code set to "${trimmed}". Refresh the page to apply.`);
                } else {
                    alert('Invalid value. IATA code must be 8 characters or less.');
                }
            }
        });
    }

    // ============================================
    // USER PROFILE (from API response)
    // ============================================
    let userProfile = {
        loaded: false,
        pointsBalance: null,
        programs: []  // Array of { programCode, levelCode, levelDescription }
    };

    function loadUserProfileFromStorage() {
        try {
            const stored = sessionStorage.getItem('stayvalue_user');
            if (stored) {
                const data = JSON.parse(stored);
                // Only load if less than 1 hour old
                if (data.timestamp && Date.now() - data.timestamp < 3600000) {
                    userProfile = { ...data, loaded: true };
                    log('Loaded user profile from storage:', userProfile);
                }
            }
        } catch (e) {
            log('Error loading user profile:', e);
        }
    }

    function saveUserProfileToStorage() {
        try {
            sessionStorage.setItem('stayvalue_user', JSON.stringify({
                ...userProfile,
                timestamp: Date.now()
            }));
        } catch (e) {
            log('Error saving user profile:', e);
        }
    }

    function parseUserProfileResponse(data) {
        try {
            userProfile.loaded = true;
            userProfile.programs = [];

            if (data.programs && Array.isArray(data.programs)) {
                data.programs.forEach(prog => {
                    userProfile.programs.push({
                        programCode: prog.programCode,
                        levelCode: prog.levelCode,
                        levelDescription: prog.levelDescription
                    });

                    // Get points balance from main PC (Priority Club) program
                    if (prog.programCode === 'PC' && prog.currentPointsBalance) {
                        userProfile.pointsBalance = prog.currentPointsBalance;
                    }
                });
            }

            log('Parsed user profile:', userProfile);
            saveUserProfileToStorage();

            // Show user status notification
            const pcProgram = userProfile.programs.find(p => p.programCode === 'PC');
            if (pcProgram) {
                showInfo(`StayValue: ${pcProgram.levelDescription} | ${userProfile.pointsBalance?.toLocaleString() || 0} pts`);
            }
        } catch (e) {
            log('Error parsing user profile:', e);
        }
    }

    // ============================================
    // CURRENCY CONVERSION RATES
    // ============================================
    // Key: "CNY_USD" (fromCurrency_toCurrency)
    // Value: { rate, fromCurrency, toCurrency, timestamp }
    const currencyRates = new Map();

    function loadCurrencyRatesFromStorage() {
        try {
            const stored = sessionStorage.getItem('stayvalue_currencies');
            if (stored) {
                const data = JSON.parse(stored);
                // Only load if less than 24 hours old (exchange rates don't change often)
                if (data.timestamp && Date.now() - data.timestamp < 86400000) {
                    Object.entries(data.rates || {}).forEach(([key, value]) => {
                        currencyRates.set(key, value);
                    });
                    log('Loaded', currencyRates.size, 'currency rates from storage');
                }
            }
        } catch (e) {
            log('Error loading currency rates:', e);
        }
    }

    function saveCurrencyRatesToStorage() {
        try {
            const data = {
                timestamp: Date.now(),
                rates: Object.fromEntries(currencyRates)
            };
            sessionStorage.setItem('stayvalue_currencies', JSON.stringify(data));
        } catch (e) {
            log('Error saving currency rates:', e);
        }
    }

    function parseCurrencyConversionResponse(data) {
        try {
            if (!data || !data.fromCurrency || !data.toCurrency || !data.results) {
                log('Invalid currency conversion response');
                return;
            }

            const fromCode = data.fromCurrency.code;
            const toCode = data.toCurrency.code;

            // Find the "P" source rate (the actual exchange rate we want)
            const pResult = data.results.find(r => r.source === 'P');
            if (!pResult) {
                log('No "P" source found in currency conversion response');
                return;
            }

            const key = `${fromCode}_${toCode}`;
            const rateData = {
                rate: pResult.result, // This is the conversion rate (e.g., 0.1428 for CNY->USD)
                fromCurrency: fromCode,
                toCurrency: toCode,
                fromSymbol: data.fromCurrency.symbol,
                toSymbol: data.toCurrency.symbol,
                timestamp: Date.now()
            };

            currencyRates.set(key, rateData);
            log('Stored currency rate:', key, '=', rateData.rate, `(1 ${fromCode} = ${rateData.rate} ${toCode})`);

            saveCurrencyRatesToStorage();

            // Reprocess page when we get a new exchange rate
            debouncedProcess();
        } catch (e) {
            log('Error parsing currency conversion response:', e);
        }
    }

    // Convert amount from one currency to USD
    function convertToUSD(amount, fromCurrency) {
        if (!amount || fromCurrency === 'USD') {
            return parseFloat(amount);
        }

        const key = `${fromCurrency}_USD`;
        const rateData = currencyRates.get(key);
        if (!rateData) {
            log('No exchange rate found for', key);
            return null;
        }

        return parseFloat(amount) * rateData.rate;
    }

    // ============================================
    // HOTEL RATE CACHE (from API)
    // ============================================
    // Key: hotel code (e.g., "SYXSB")
    // Value: { apiData, apiTimestamp }
    const hotelCache = new Map();

    function loadHotelCacheFromStorage() {
        try {
            const stored = sessionStorage.getItem('stayvalue_hotels');
            if (stored) {
                const data = JSON.parse(stored);
                // Only load if less than 1 hour old
                if (data.timestamp && Date.now() - data.timestamp < 3600000) {
                    Object.entries(data.hotels || {}).forEach(([key, value]) => {
                        hotelCache.set(key, value);
                    });
                    log('Loaded', hotelCache.size, 'hotels from storage');
                }
            }
        } catch (e) {
            log('Error loading hotel cache:', e);
        }
    }

    function saveHotelCacheToStorage() {
        try {
            const data = {
                timestamp: Date.now(),
                hotels: Object.fromEntries(hotelCache)
            };
            sessionStorage.setItem('stayvalue_hotels', JSON.stringify(data));
        } catch (e) {
            log('Error saving hotel cache:', e);
        }
    }

    // ============================================
    // AVAILABILITY API PARSING
    // ============================================
    function parseAvailabilityResponse(data) {
        try {
            if (!data || !data.hotels || !Array.isArray(data.hotels)) {
                log('No hotels in availability response');
                return;
            }

            log('Parsing availability response with', data.hotels.length, 'hotels');

            data.hotels.forEach(hotel => {
                const hotelCode = hotel.hotelMnemonic;
                if (!hotelCode) return;

                // Build API data object with only the fields we need
                const apiData = {
                    propertyCurrency: hotel.propertyCurrency,
                    brandCode: hotel.brandCode
                };

                // Store lowest cash only cost
                if (hotel.lowestCashOnlyCost) {
                    apiData.lowestCashOnlyCost = {
                        baseAmount: hotel.lowestCashOnlyCost.baseAmount,
                        excludedFeeSubTotal: hotel.lowestCashOnlyCost.excludedFeeSubTotal,
                        excludedTaxSubTotal: hotel.lowestCashOnlyCost.excludedTaxSubTotal,
                        amountAfterTax: hotel.lowestCashOnlyCost.amountAfterTax
                    };
                }

                // Store lowest points only cost
                if (hotel.lowestPointsOnlyCost) {
                    apiData.lowestPointsOnlyCost = {
                        points: hotel.lowestPointsOnlyCost.points
                    };
                }

                // Store rate plan definitions (for bonus point rates like IKME3, IKM5K, etc.)
                if (hotel.ratePlanDefinitions && Array.isArray(hotel.ratePlanDefinitions)) {
                    apiData.ratePlanDefinitions = hotel.ratePlanDefinitions
                        .filter(plan => plan.rateRange?.low) // Only store plans with rate data
                        .map(plan => ({
                            code: plan.code,
                            rateRange: {
                                low: {
                                    baseAmount: plan.rateRange.low.baseAmount,
                                    excludedFeeSubTotal: plan.rateRange.low.excludedFeeSubTotal,
                                    excludedTaxSubTotal: plan.rateRange.low.excludedTaxSubTotal,
                                    amountAfterTax: plan.rateRange.low.amountAfterTax
                                }
                            }
                        }));
                }

                // Update cache entry
                hotelCache.set(hotelCode, {
                    apiData,
                    apiTimestamp: Date.now()
                });

                log('Cached:', hotelCode, '| Brand:', apiData.brandCode,
                    '| Points:', apiData.lowestPointsOnlyCost?.points || 'N/A',
                    '| Cash:', apiData.lowestCashOnlyCost?.amountAfterTax || 'N/A');
            });

            saveHotelCacheToStorage();

            // Process the page now that we have data
            debouncedProcess();
        } catch (e) {
            log('Error parsing availability response:', e);
        }
    }

    // ============================================
    // NETWORK INTERCEPTION
    // ============================================
    function setupNetworkInterception() {
        // Intercept fetch requests
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);

            const url = args[0]?.url || args[0];
            if (typeof url === 'string') {
                if (url.includes('apis.ihg.com/members/v2/profiles/me')) {
                    try {
                        const clone = response.clone();
                        const data = await clone.json();
                        log('Intercepted profile API response');
                        parseUserProfileResponse(data);
                    } catch (e) {
                        log('Error intercepting profile response:', e);
                    }
                }

                if (url.includes('apis.ihg.com/availability/v3/hotels/offers')) {
                    try {
                        const clone = response.clone();
                        const data = await clone.json();
                        log('Intercepted availability API response');
                        parseAvailabilityResponse(data);
                    } catch (e) {
                        log('Error intercepting availability response:', e);
                    }
                }

                if (url.includes('apis.ihg.com/finance/conversions/v2/currencies')) {
                    try {
                        const clone = response.clone();
                        const data = await clone.json();
                        log('Intercepted currency conversion API response');
                        parseCurrencyConversionResponse(data);
                    } catch (e) {
                        log('Error intercepting currency conversion response:', e);
                    }
                }
            }

            return response;
        };

        // Also intercept XMLHttpRequest for older code paths
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._stayvalueUrl = url;
            return originalXHROpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function(...args) {
            const self = this;
            const url = this._stayvalueUrl;

            if (url) {
                if (url.includes('apis.ihg.com/members/v2/profiles/me')) {
                    this.addEventListener('load', function() {
                        try {
                            const data = JSON.parse(self.responseText);
                            log('Intercepted profile XHR response');
                            parseUserProfileResponse(data);
                        } catch (e) {
                            log('Error parsing XHR profile response:', e);
                        }
                    });
                }

                if (url.includes('apis.ihg.com/availability/v3/hotels/offers')) {
                    this.addEventListener('load', function() {
                        try {
                            const data = JSON.parse(self.responseText);
                            log('Intercepted availability XHR response');
                            parseAvailabilityResponse(data);
                        } catch (e) {
                            log('Error parsing XHR availability response:', e);
                        }
                    });
                }

                if (url.includes('apis.ihg.com/finance/conversions/v2/currencies')) {
                    this.addEventListener('load', function() {
                        try {
                            const data = JSON.parse(self.responseText);
                            log('Intercepted currency conversion XHR response');
                            parseCurrencyConversionResponse(data);
                        } catch (e) {
                            log('Error parsing XHR currency conversion response:', e);
                        }
                    });
                }
            }
            return originalXHRSend.apply(this, args);
        };

        log('Network interception set up');
    }

    // ============================================
    // STYLING
    // ============================================
    const STYLES = `
        .stayvalue-cpp {
            font-size: 12px;
            color: #666;
            margin-left: 4px;
            font-weight: normal;
        }
        .stayvalue-cpp.good-value {
            color: #2e7d32;
            font-weight: 600;
        }
        .stayvalue-cpp.bad-value {
            color: #c62828;
        }
        .stayvalue-badge {
            display: inline-flex;
            align-items: center;
            background: #e8f5e9;
            color: #2e7d32;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            margin-left: 6px;
        }
        .stayvalue-badge::before {
            content: "✓ ";
        }
        .stayvalue-cash-note {
            font-size: 10px;
            color: #888;
            margin-left: 4px;
        }
        .stayvalue-best-rate {
            font-size: 11px;
            margin-top: 2px;
            color: #555;
        }
        .stayvalue-best-rate .best {
            font-weight: 600;
            color: #2e7d32;
        }
        .stayvalue-best-rate .alt {
            color: #888;
        }
        .stayvalue-best-rate .savings {
            color: #1565c0;
            font-size: 10px;
        }
        .stayvalue-info {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #333;
            color: #fff;
            padding: 10px 15px;
            border-radius: 8px;
            font-size: 12px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .stayvalue-info.hidden {
            display: none;
        }
    `;

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================
    function log(...args) {
        if (CONFIG.debug) {
            console.log('[StayValue]', ...args);
        }
    }

    // Get user's elite status level code
    function getUserEliteLevel() {
        const pcProgram = userProfile.programs.find(p => p.programCode === 'PC');
        if (pcProgram?.levelCode) {
            return pcProgram.levelCode;
        }
        return CONFIG.IHG.defaultEliteStatus;
    }

    // Get points earned per dollar for current elite status and brand
    // Formula: brandBasePoints * (1 + eliteBonusRate)
    function getPointsPerDollar(brandCode) {
        const level = getUserEliteLevel();
        const basePoints = CONFIG.IHG.brandBasePoints[brandCode] || CONFIG.IHG.brandBasePoints['default'];
        const bonusRate = CONFIG.IHG.eliteBonusRate[level] ?? CONFIG.IHG.eliteBonusRate['CLUB'];
        return basePoints * (1 + bonusRate);
    }

    // Calculate effective CPP based on net cash cost and net points
    // Net points = points to redeem + points you would have earned from cash booking
    function calculateCPP(netCashCost, pointsToRedeem, pointsEarned) {
        const netPoints = pointsToRedeem + pointsEarned;
        if (!netCashCost || !netPoints || netPoints <= 0) return null;
        // cpp = (net cash cost in cents) / net points
        return (netCashCost * 100) / netPoints;
    }

    function formatCPP(cpp) {
        if (cpp === null) return '';
        return cpp.toFixed(2) + ' cpp';
    }

    // Format dollar amount for display (configurable decimal places)
    function fmtDollars(amount) {
        if (amount === null || amount === undefined) return '?';
        return amount.toFixed(USER_CONFIG.dollarDecimals);
    }

    // Format points for display (rounded integer with commas)
    function fmtPoints(points) {
        if (points === null || points === undefined) return '?';
        return Math.round(points).toLocaleString();
    }

    // Format percentage for display
    function fmtPercent(rate) {
        return (rate * 100).toFixed(1);
    }

    function isGoodValue(cpp, threshold) {
        return cpp !== null && cpp >= threshold;
    }

    // Calculate the effective cost of redeeming points
    // Uses user's personal point valuation
    function calculatePointsEffectiveCost(points) {
        if (!points || points <= 0) return null;
        // pointValue is in cents, convert to dollars
        return points * USER_CONFIG.pointValue / 100;
    }

    // Determine the best rate between cash and points
    // Returns: { bestRate: 'cash'|'points'|null, cashCost, pointsCost, savings }
    function determineBestRate(cashEffective, pointsEffectiveCost) {
        // If neither available, return null
        if (cashEffective === null && pointsEffectiveCost === null) {
            return null;
        }

        // If only cash available
        if (pointsEffectiveCost === null) {
            return {
                bestRate: 'cash',
                cashCost: cashEffective,
                pointsCost: null,
                savings: null
            };
        }

        // If only points available (shouldn't happen on IHG, but handle it)
        if (cashEffective === null) {
            return {
                bestRate: 'points',
                cashCost: null,
                pointsCost: pointsEffectiveCost,
                savings: null
            };
        }

        // Both available - compare
        const savings = Math.abs(cashEffective - pointsEffectiveCost);
        if (pointsEffectiveCost < cashEffective) {
            return {
                bestRate: 'points',
                cashCost: cashEffective,
                pointsCost: pointsEffectiveCost,
                savings: savings
            };
        } else {
            return {
                bestRate: 'cash',
                cashCost: cashEffective,
                pointsCost: pointsEffectiveCost,
                savings: savings
            };
        }
    }

    // Find the best cash rate among all rate plans
    // Returns: { rateCode, bonusPoints, totalUSD, roomRateUSD, feesUSD, taxesUSD, effectiveCost, effectiveCalc }
    function findBestCashRate(apiData, convertFn, brandCode) {
        const candidates = [];

        // Always include the lowest cash rate as baseline
        if (apiData.lowestCashOnlyCost) {
            const cash = apiData.lowestCashOnlyCost;
            const totalUSD = convertFn(cash.amountAfterTax);
            const roomRateUSD = convertFn(cash.baseAmount);
            const feesUSD = convertFn(cash.excludedFeeSubTotal) || 0;
            const taxesUSD = convertFn(cash.excludedTaxSubTotal) || 0;

            if (totalUSD !== null && roomRateUSD !== null) {
                const effectiveCalc = calculateCashEffectiveCostWithBonus(totalUSD, roomRateUSD, 0, brandCode);
                candidates.push({
                    rateCode: 'lowest',
                    bonusPoints: 0,
                    totalUSD,
                    roomRateUSD,
                    feesUSD,
                    taxesUSD,
                    effectiveCost: effectiveCalc.effectiveCost,
                    effectiveCalc
                });
            }
        }

        // Check all rate plan definitions for bonus point rates
        if (apiData.ratePlanDefinitions && Array.isArray(apiData.ratePlanDefinitions)) {
            apiData.ratePlanDefinitions.forEach(plan => {
                // Skip if no rate range or no low rate
                if (!plan.rateRange?.low?.amountAfterTax) return;

                // Check if this rate offers bonus points
                const bonusPoints = CONFIG.IHG.bonusPointsRates[plan.code] || 0;

                const totalUSD = convertFn(plan.rateRange.low.amountAfterTax);
                const roomRateUSD = convertFn(plan.rateRange.low.baseAmount);
                const feesUSD = convertFn(plan.rateRange.low.excludedFeeSubTotal) || 0;
                const taxesUSD = convertFn(plan.rateRange.low.excludedTaxSubTotal) || 0;

                if (totalUSD !== null && roomRateUSD !== null) {
                    const effectiveCalc = calculateCashEffectiveCostWithBonus(totalUSD, roomRateUSD, bonusPoints, brandCode);
                    candidates.push({
                        rateCode: plan.code,
                        bonusPoints,
                        totalUSD,
                        roomRateUSD,
                        feesUSD,
                        taxesUSD,
                        effectiveCost: effectiveCalc.effectiveCost,
                        effectiveCalc
                    });
                }
            });
        }

        if (candidates.length === 0) return null;

        // Find the one with lowest effective cost
        candidates.sort((a, b) => a.effectiveCost - b.effectiveCost);
        return candidates[0];
    }

    // Calculate cash effective cost with bonus points and rebates
    function calculateCashEffectiveCostWithBonus(totalUSD, roomRateUSD, bonusPoints, brandCode) {
        const cashback = totalUSD * USER_CONFIG.cashbackRate;
        const travelAgentRebate = roomRateUSD * USER_CONFIG.travelAgentRebateRate;
        const basePointsEarned = roomRateUSD * getPointsPerDollar(brandCode);
        const totalPointsEarned = basePointsEarned + bonusPoints;
        const pointsValue = totalPointsEarned * USER_CONFIG.pointValue / 100;
        const effectiveCost = totalUSD - cashback - travelAgentRebate - pointsValue;

        return {
            grossCost: totalUSD,
            roomRate: roomRateUSD,
            cashback: cashback,
            travelAgentRebate: travelAgentRebate,
            basePointsEarned: basePointsEarned,
            bonusPoints: bonusPoints,
            totalPointsEarned: totalPointsEarned,
            pointsValue: pointsValue,
            effectiveCost: effectiveCost
        };
    }

    // ============================================
    // DOM INJECTION
    // ============================================
    function injectStyles() {
        if (document.getElementById('stayvalue-styles')) return;
        const style = document.createElement('style');
        style.id = 'stayvalue-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
        log('Styles injected');
    }

    function createCPPElement(cpp, isGood) {
        const span = document.createElement('span');
        span.className = 'stayvalue-cpp' + (isGood ? ' good-value' : ' bad-value');
        span.textContent = '(' + formatCPP(cpp) + ')';
        return span;
    }

    function createBadge() {
        const badge = document.createElement('span');
        badge.className = 'stayvalue-badge';
        badge.textContent = 'Better Value';
        return badge;
    }

    let infoBox = null;
    function showInfo(message) {
        if (!infoBox) {
            infoBox = document.createElement('div');
            infoBox.className = 'stayvalue-info';
            document.body.appendChild(infoBox);
        }
        infoBox.textContent = message;
        infoBox.classList.remove('hidden');
        setTimeout(() => {
            if (infoBox) infoBox.classList.add('hidden');
        }, 3000);
    }

    // ============================================
    // HOTEL CARD DETECTION
    // ============================================
    function findHotelCards() {
        // IHG uses app-hotel-card-list-view components
        const cards = document.querySelectorAll('app-hotel-card-list-view');
        log('Found', cards.length, 'hotel cards');
        return Array.from(cards);
    }

    function getHotelCodeFromCard(card) {
        // Hotel code from card ID attribute (e.g., "SYXSB")
        return card.id || card.getAttribute('data-testid')?.replace('hotel-card-', '');
    }

    // ============================================
    // MAIN PROCESSING
    // ============================================
    function processHotelCards() {
        log('Processing hotel cards...');
        log('Hotel cache has', hotelCache.size, 'entries');
        log('Currency rates available:', Array.from(currencyRates.keys()));

        const cards = findHotelCards();
        let processed = 0;
        let needsCurrencyRate = new Set();

        cards.forEach(card => {
            // Skip already processed cards
            if (card.hasAttribute('data-stayvalue-processed')) {
                return;
            }

            const hotelCode = getHotelCodeFromCard(card);
            if (!hotelCode) {
                log('No hotel code found for card');
                return;
            }

            // Get cached API data
            const cached = hotelCache.get(hotelCode);
            if (!cached?.apiData) {
                log('No API data for:', hotelCode);
                return;
            }

            const apiData = cached.apiData;
            const currency = apiData.propertyCurrency;
            const brandCode = apiData.brandCode;
            const points = apiData.lowestPointsOnlyCost?.points;

            // Create a conversion function for this currency
            const convertFn = (amount) => {
                if (amount === null || amount === undefined) return null;
                if (currency === 'USD') return parseFloat(amount);
                return convertToUSD(amount, currency);
            };

            // Check if we have the exchange rate (if needed)
            if (currency !== 'USD' && !currencyRates.has(`${currency}_USD`)) {
                needsCurrencyRate.add(currency);
                log('Waiting for exchange rate:', currency, '-> USD for', hotelCode);
                return;
            }

            // Find the best cash rate among all rate plans (including bonus point rates)
            const bestCashRate = findBestCashRate(apiData, convertFn, brandCode);
            if (!bestCashRate) {
                log('No valid cash rate for:', hotelCode);
                return;
            }

            // Calculate points effective cost
            const pointsEffectiveCost = points ? calculatePointsEffectiveCost(points) : null;

            // Determine best rate using the best cash rate's effective cost
            const bestRateInfo = determineBestRate(bestCashRate.effectiveCost, pointsEffectiveCost);

            // Add best cash rate details to bestRateInfo
            if (bestRateInfo) {
                bestRateInfo.bestCashRate = bestCashRate;
            }

            // Calculate CPP using best cash rate (including bonus points)
            let cpp = null;
            let isGood = false;
            let netPoints = null;

            if (points) {
                // Use best cash rate for CPP calculation
                const effCalc = bestCashRate.effectiveCalc;
                // Net cost = gross - cashback - travel agent rebate (don't subtract points value for CPP)
                const netCashCost = effCalc.grossCost - effCalc.cashback - effCalc.travelAgentRebate;
                // Net points = points to redeem + total points earned (base + bonus)
                netPoints = points + effCalc.totalPointsEarned;
                cpp = calculateCPP(netCashCost, points, effCalc.totalPointsEarned);
                isGood = isGoodValue(cpp, USER_CONFIG.pointValue);
            }

            const eliteLevel = getUserEliteLevel();

            log('Hotel:', hotelCode,
                '| Brand:', brandCode,
                '| Type:', points ? 'points+cash' : 'cash-only',
                '| CPP:', cpp?.toFixed(2) || 'N/A',
                '| Best rate:', bestRateInfo?.bestRate || 'N/A',
                '| Best cash:', bestCashRate.rateCode,
                bestCashRate.bonusPoints > 0 ? `(+${bestCashRate.bonusPoints})` : '',
                '| Cash eff:', bestCashRate.effectiveCost.toFixed(2),
                '| Points eff:', pointsEffectiveCost?.toFixed(2) || 'N/A',
                '| Elite:', eliteLevel,
                '| Pts/$:', getPointsPerDollar(brandCode).toFixed(0));

            // Inject display
            injectCPPDisplay(card, hotelCode, cpp, {
                points,
                netPoints,
                cashEffectiveCalc: bestCashRate.effectiveCalc,
                pointsEffectiveCost,
                bestRateInfo,
                bestCashRate,
                eliteLevel
            }, isGood);

            card.setAttribute('data-stayvalue-processed', 'true');
            processed++;
        });

        if (processed > 0) {
            showInfo(`StayValue: Processed ${processed} hotels`);
        } else if (needsCurrencyRate.size > 0) {
            showInfo(`StayValue: Waiting for exchange rate (${Array.from(needsCurrencyRate).join(', ')})`);
        } else if (hotelCache.size === 0) {
            log('No hotel data cached yet');
        }
    }

    function injectCPPDisplay(card, hotelCode, cpp, cashData, isGood) {
        try {
            // Check if already injected
            if (card.querySelector('.stayvalue-display')) {
                return;
            }

            // Find the container to inject after:
            // - For hotels with points: after app-hotel-point
            // - For cash-only hotels: after app-hotel-cash
            let container = card.querySelector('app-hotel-point');
            if (!container) {
                container = card.querySelector('app-hotel-cash');
            }

            if (!container) {
                log('Could not find container for:', hotelCode);
                return;
            }

            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'stayvalue-display';
            wrapper.style.cssText = 'display: flex; flex-direction: column; margin-top: 4px; align-items: flex-end; text-align: right;';

            // First row: CPP info (if points available)
            if (cpp !== null && cashData.cashEffectiveCalc) {
                const cppRow = document.createElement('div');
                cppRow.style.cssText = 'display: flex; align-items: center; flex-wrap: wrap;';

                // CPP element
                const cppEl = createCPPElement(cpp, isGood);

                // Build tooltip with full breakdown
                const calc = cashData.cashEffectiveCalc;
                const best = cashData.bestCashRate;
                const netCost = calc.grossCost - calc.cashback - calc.travelAgentRebate;

                // Build gross breakdown (only show fees/tax if > 0)
                let grossBreakdown = `$${fmtDollars(best.roomRateUSD)} room`;
                if (best.feesUSD > 0) grossBreakdown += ` + $${fmtDollars(best.feesUSD)} fees`;
                if (best.taxesUSD > 0) grossBreakdown += ` + $${fmtDollars(best.taxesUSD)} tax`;

                let tooltip = `Best cash rate: ${best.rateCode}`;
                if (calc.bonusPoints > 0) {
                    tooltip += ` (+${fmtPoints(calc.bonusPoints)} bonus)`;
                }
                tooltip += `\n  Gross: $${fmtDollars(calc.grossCost)} (${grossBreakdown})\n`;
                tooltip += `  Cashback (${fmtPercent(USER_CONFIG.cashbackRate)}%): -$${fmtDollars(calc.cashback)}\n`;
                if (USER_CONFIG.travelAgentRebateRate > 0) {
                    tooltip += `  TA Rebate (${fmtPercent(USER_CONFIG.travelAgentRebateRate)}%): -$${fmtDollars(calc.travelAgentRebate)}\n`;
                }
                tooltip += `  Net cost: $${fmtDollars(netCost)}\n`;
                tooltip += `  Points earned: ${fmtPoints(calc.totalPointsEarned)}`;
                if (calc.bonusPoints > 0) {
                    tooltip += ` (${fmtPoints(calc.basePointsEarned)} base + ${fmtPoints(calc.bonusPoints)} bonus)`;
                }
                tooltip += `\n\nPoints booking:\n`;
                tooltip += `  Points needed: ${fmtPoints(cashData.points)}\n`;
                tooltip += `  Foregone earnings: ${fmtPoints(calc.totalPointsEarned)}\n`;
                tooltip += `  Net points: ${fmtPoints(cashData.netPoints)}\n\n`;
                tooltip += `Elite: ${cashData.eliteLevel}`;

                cppEl.title = tooltip;
                cppRow.appendChild(cppEl);

                // Badge if good value
                if (isGood) {
                    cppRow.appendChild(createBadge());
                }

                wrapper.appendChild(cppRow);
            }

        // Second row: Best rate comparison
        const bestRateInfo = cashData.bestRateInfo;
        const bestCashRate = cashData.bestCashRate;
        if (bestRateInfo) {
            const bestRow = document.createElement('div');
            bestRow.className = 'stayvalue-best-rate';

            // Format cash label with bonus points indicator if applicable
            const bonusPoints = bestCashRate?.bonusPoints || 0;
            const bonusLabel = bonusPoints > 0
                ? ` (+${Math.round(bonusPoints / 1000)}k)`
                : '';
            const cashCostStr = bestRateInfo.cashCost !== null ? `$${fmtDollars(bestRateInfo.cashCost)}` : 'N/A';
            const pointsCostStr = bestRateInfo.pointsCost !== null ? `$${fmtDollars(bestRateInfo.pointsCost)}` : 'N/A';

            if (bestRateInfo.bestRate === 'points' && bestRateInfo.pointsCost !== null) {
                // Points is better
                bestRow.innerHTML = `<span class="best">Points ${pointsCostStr}</span> <span class="alt">vs Cash${bonusLabel} ${cashCostStr}</span>`;
                if (bestRateInfo.savings !== null && bestRateInfo.savings > 0) {
                    bestRow.innerHTML += ` <span class="savings">(save $${fmtDollars(bestRateInfo.savings)})</span>`;
                }
            } else if (bestRateInfo.bestRate === 'cash') {
                // Cash is better (or only option)
                if (bestRateInfo.pointsCost !== null) {
                    bestRow.innerHTML = `<span class="best">Cash${bonusLabel} ${cashCostStr}</span> <span class="alt">vs Points ${pointsCostStr}</span>`;
                    if (bestRateInfo.savings !== null && bestRateInfo.savings > 0) {
                        bestRow.innerHTML += ` <span class="savings">(save $${fmtDollars(bestRateInfo.savings)})</span>`;
                    }
                } else {
                    // Only cash available
                    bestRow.innerHTML = `<span class="best">Cash${bonusLabel} ${cashCostStr}</span> <span class="alt">(no points rate)</span>`;
                }
            }

            // Add tooltip explaining the effective costs
            const effCalc = cashData.cashEffectiveCalc;

            // Build gross breakdown (only show fees/tax if > 0)
            let grossBreakdown = `$${fmtDollars(bestCashRate?.roomRateUSD)} room`;
            if (bestCashRate?.feesUSD > 0) grossBreakdown += ` + $${fmtDollars(bestCashRate.feesUSD)} fees`;
            if (bestCashRate?.taxesUSD > 0) grossBreakdown += ` + $${fmtDollars(bestCashRate.taxesUSD)} tax`;

            let tooltip = `Effective cost comparison:\n\n`;
            tooltip += `Best cash rate: ${bestCashRate?.rateCode || 'lowest'}`;
            if (bonusPoints > 0) {
                tooltip += ` (+${fmtPoints(bonusPoints)} bonus pts)`;
            }
            tooltip += `\n`;
            tooltip += `  Gross: $${fmtDollars(effCalc.grossCost)} (${grossBreakdown})\n`;
            tooltip += `  Cashback (${fmtPercent(USER_CONFIG.cashbackRate)}%): -$${fmtDollars(effCalc.cashback)}\n`;
            if (USER_CONFIG.travelAgentRebateRate > 0) {
                tooltip += `  TA Rebate (${fmtPercent(USER_CONFIG.travelAgentRebateRate)}%): -$${fmtDollars(effCalc.travelAgentRebate)}\n`;
            }
            if (effCalc.basePointsEarned !== undefined) {
                tooltip += `  Base points: ${fmtPoints(effCalc.basePointsEarned)}\n`;
                if (bonusPoints > 0) {
                    tooltip += `  Bonus points: +${fmtPoints(bonusPoints)}\n`;
                }
                tooltip += `  Total points: ${fmtPoints(effCalc.totalPointsEarned)}\n`;
            } else {
                tooltip += `  Points earned: ${fmtPoints(effCalc.pointsEarned)}\n`;
            }
            tooltip += `  Points value (${USER_CONFIG.pointValue}¢/pt): -$${fmtDollars(effCalc.pointsValue)}\n`;
            tooltip += `  Effective cost: $${fmtDollars(effCalc.effectiveCost)}\n\n`;

            if (bestRateInfo.pointsCost !== null && cashData.points) {
                tooltip += `Points redemption:\n`;
                tooltip += `  Points to redeem: ${fmtPoints(cashData.points)}\n`;
                tooltip += `  Point value (${USER_CONFIG.pointValue}¢/pt): $${fmtDollars(bestRateInfo.pointsCost)}\n`;
            }

            bestRow.title = tooltip;
            wrapper.appendChild(bestRow);
        }

        // Append after container
        container.parentNode.insertBefore(wrapper, container.nextSibling);
        log('Injected display for:', hotelCode);
        } catch (e) {
            log('Error injecting display for', hotelCode, ':', e.message);
        }
    }

    // ============================================
    // DEBOUNCE AND PROCESS
    // ============================================
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    const debouncedProcess = debounce(processHotelCards, 300);

    // ============================================
    // IATA CODE INJECTION
    // ============================================

    // Fill IATA input field if found on the page
    function fillIataInput() {
        if (!USER_CONFIG.iataCode) return;

        const iataInput = document.querySelector('input[name="iata"]');
        if (iataInput && iataInput.value !== USER_CONFIG.iataCode) {
            iataInput.value = USER_CONFIG.iataCode;
            // Trigger input event so Angular picks up the change
            iataInput.dispatchEvent(new Event('input', { bubbles: true }));
            iataInput.dispatchEvent(new Event('change', { bubbles: true }));
            log('Filled IATA input with:', USER_CONFIG.iataCode);
        }
    }

    // Observe DOM for IATA input fields appearing
    function setupIataObserver() {
        if (!USER_CONFIG.iataCode) return;

        const observer = new MutationObserver(() => {
            fillIataInput();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Also fill immediately if input exists
        fillIataInput();
    }

    // ============================================
    // INITIALIZATION
    // ============================================
    function init() {
        log('StayValue v1.16.0 initializing...');
        log('Point valuation:', USER_CONFIG.pointValue, 'cpp');
        log('Cashback rate:', (USER_CONFIG.cashbackRate * 100) + '%');
        log('TA rebate rate:', (USER_CONFIG.travelAgentRebateRate * 100) + '%');
        log('IATA code:', USER_CONFIG.iataCode || 'not set');
        log('Default elite status:', CONFIG.IHG.defaultEliteStatus);

        setupMenuCommands();
        injectStyles();
        loadUserProfileFromStorage();
        loadCurrencyRatesFromStorage();
        loadHotelCacheFromStorage();
        setupNetworkInterception();
        setupIataObserver();

        // Initial processing after a short delay (let Angular render)
        setTimeout(processHotelCards, 1500);

        // Observe DOM changes for SPA navigation and dynamic content
        const observer = new MutationObserver((mutations) => {
            const hasRelevantChanges = mutations.some(mutation => {
                return Array.from(mutation.addedNodes).some(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return false;
                    // Ignore our own injections
                    if (node.classList && (
                        node.classList.contains('stayvalue-cpp') ||
                        node.classList.contains('stayvalue-badge') ||
                        node.classList.contains('stayvalue-display') ||
                        node.classList.contains('stayvalue-info')
                    )) return false;
                    // Look for hotel cards being added
                    if (node.tagName === 'APP-HOTEL-CARD-LIST-VIEW') return true;
                    if (node.querySelector && node.querySelector('app-hotel-card-list-view')) return true;
                    return false;
                });
            });

            if (hasRelevantChanges) {
                log('Relevant DOM changes detected, reprocessing...');
                debouncedProcess();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Listen for URL changes (SPA navigation)
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('URL changed to:', lastUrl);
                // Clear processed markers when URL changes
                document.querySelectorAll('[data-stayvalue-processed]').forEach(el => {
                    el.removeAttribute('data-stayvalue-processed');
                });
                document.querySelectorAll('.stayvalue-display').forEach(el => el.remove());
                setTimeout(processHotelCards, 1500);
            }
        });
        urlObserver.observe(document, { subtree: true, childList: true });

        log('StayValue initialized');
        showInfo('StayValue active');
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
