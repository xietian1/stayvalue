// ==UserScript==
// @name         StayValue
// @namespace    https://github.com/chaoxu/stayvalue
// @version      1.11.0
// @description  Compare hotel point rates vs cash rates - shows cents-per-point (cpp) and highlights better value
// @match        https://www.ihg.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // USER CONFIGURATION - Adjust these values!
    // ============================================
    const CONFIG = {
        IHG: {
            pointValue: 0.5,  // Your personal valuation in cents per point
            cashbackRate: 0.05,  // 5% cashback on total price (credit card, portal, etc.)
            // Points earned per dollar spent on room rate (baseAmount) by elite status
            pointsPerDollar: {
                'CLUB': 10,      // Normal member
                'SILVER': 12,    // Silver Elite
                'GOLD': 14,      // Gold Elite
                'PLATINUM': 16,  // Platinum Elite
                'DIAMOND': 20    // Diamond Elite
            },
            defaultEliteStatus: 'DIAMOND',  // Used if not logged in or status unknown
            // Rate plans that offer bonus points
            bonusPointsRates: {
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
    // USER PROFILE (from API response)
    // ============================================
    let userProfile = {
        loaded: false,
        memberNumber: null,
        firstName: null,
        lastName: null,
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
            userProfile.memberNumber = data.rewardsClubMemberNumber || null;
            userProfile.firstName = data.name?.firstName || null;
            userProfile.lastName = data.name?.lastName || null;

            // Extract programs with their levels
            userProfile.programs = [];
            if (data.programs && Array.isArray(data.programs)) {
                data.programs.forEach(prog => {
                    const programInfo = {
                        programCode: prog.programCode,
                        levelCode: prog.levelCode,
                        levelDescription: prog.levelDescription,
                        pointsBalance: prog.currentPointsBalance || null,
                        enrollmentDate: prog.enrollmentDate || null,
                        expirationDate: prog.levelExpirationDate || prog.membershipExpirationDate || null
                    };
                    userProfile.programs.push(programInfo);

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

    // Helper functions for user profile
    function getUserEliteStatus() {
        const pcProgram = userProfile.programs.find(p => p.programCode === 'PC');
        return pcProgram ? {
            levelCode: pcProgram.levelCode,
            levelDescription: pcProgram.levelDescription,
            pointsBalance: userProfile.pointsBalance
        } : null;
    }

    function hasAmbassadorStatus() {
        return userProfile.programs.some(p => p.programCode === 'AMB');
    }

    function getPointsBalance() {
        return userProfile.pointsBalance || 0;
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

            const searchInfo = {
                startDate: data.startDate,
                endDate: data.endDate
            };

            log('Parsing availability response:', searchInfo, 'with', data.hotels.length, 'hotels');

            data.hotels.forEach(hotel => {
                const hotelCode = hotel.hotelMnemonic;
                if (!hotelCode) return;

                // Build API data object with all the detailed rate information
                const apiData = {
                    availabilityStatus: hotel.availabilityStatus,
                    rewardNightAvailable: hotel.rewardNightAvailable,
                    propertyCurrency: hotel.propertyCurrency,
                    brandCode: hotel.brandCode,
                    isoCountryCode: hotel.isoCountryCode,
                    searchStartDate: searchInfo.startDate,
                    searchEndDate: searchInfo.endDate
                };

                // Store lowest cash only cost (with breakdown)
                if (hotel.lowestCashOnlyCost) {
                    apiData.lowestCashOnlyCost = {
                        baseAmount: hotel.lowestCashOnlyCost.baseAmount,
                        excludedFeeSubTotal: hotel.lowestCashOnlyCost.excludedFeeSubTotal,
                        excludedTaxSubTotal: hotel.lowestCashOnlyCost.excludedTaxSubTotal,
                        amountAfterTax: hotel.lowestCashOnlyCost.amountAfterTax,
                        basePlusExcludedFeesAmount: hotel.lowestCashOnlyCost.basePlusExcludedFeesAmount,
                        numberOfAvailableProducts: hotel.lowestCashOnlyCost.numberOfAvailableProducts
                    };
                }

                // Store highest cash only cost
                if (hotel.highestCashOnlyCost) {
                    apiData.highestCashOnlyCost = {
                        baseAmount: hotel.highestCashOnlyCost.baseAmount,
                        excludedFeeSubTotal: hotel.highestCashOnlyCost.excludedFeeSubTotal,
                        excludedTaxSubTotal: hotel.highestCashOnlyCost.excludedTaxSubTotal,
                        amountAfterTax: hotel.highestCashOnlyCost.amountAfterTax,
                        basePlusExcludedFeesAmount: hotel.highestCashOnlyCost.basePlusExcludedFeesAmount,
                        ratePlanType: hotel.highestCashOnlyCost.ratePlanType
                    };
                }

                // Store lowest points only cost
                if (hotel.lowestPointsOnlyCost) {
                    apiData.lowestPointsOnlyCost = {
                        points: hotel.lowestPointsOnlyCost.points,
                        originalPoints: hotel.lowestPointsOnlyCost.originalPoints
                    };
                }

                // Store highest points only cost
                if (hotel.highestPointsOnlyCost) {
                    apiData.highestPointsOnlyCost = {
                        points: hotel.highestPointsOnlyCost.points,
                        originalPoints: hotel.highestPointsOnlyCost.originalPoints
                    };
                }

                // Store lowest points and cash cost
                if (hotel.lowestPointsAndCashCost) {
                    apiData.lowestPointsAndCashCost = {
                        points: hotel.lowestPointsAndCashCost.points,
                        cash: hotel.lowestPointsAndCashCost.cash,
                        originalPoints: hotel.lowestPointsAndCashCost.originalPoints,
                        originalCash: hotel.lowestPointsAndCashCost.originalCash
                    };
                }

                // Store highest points and cash cost
                if (hotel.highestPointsAndCashCost) {
                    apiData.highestPointsAndCashCost = {
                        points: hotel.highestPointsAndCashCost.points,
                        cash: hotel.highestPointsAndCashCost.cash,
                        originalPoints: hotel.highestPointsAndCashCost.originalPoints,
                        originalCash: hotel.highestPointsAndCashCost.originalCash
                    };
                }

                // Store rate plan definitions (IKME3, IKME4, etc.)
                if (hotel.ratePlanDefinitions && Array.isArray(hotel.ratePlanDefinitions)) {
                    apiData.ratePlanDefinitions = hotel.ratePlanDefinitions
                        .filter(plan => plan.rateRange || plan.isRewardNight) // Only store plans with actual rate data
                        .map(plan => {
                            const planData = {
                                code: plan.code,
                                isPreferred: plan.isPreferred,
                                isAvailable: plan.isAvailable !== false, // default to true if not specified
                                isRewardNight: plan.isRewardNight || false
                            };

                            if (plan.providerDescription) {
                                planData.providerDescription = plan.providerDescription;
                            }
                            if (plan.customDisplay) {
                                planData.customDisplay = plan.customDisplay;
                            }
                            if (plan.types) {
                                planData.types = plan.types;
                            }

                            // Store rate range if available
                            if (plan.rateRange) {
                                planData.rateRange = {};
                                if (plan.rateRange.low) {
                                    planData.rateRange.low = {
                                        baseAmount: plan.rateRange.low.baseAmount,
                                        excludedFeeSubTotal: plan.rateRange.low.excludedFeeSubTotal,
                                        excludedTaxSubTotal: plan.rateRange.low.excludedTaxSubTotal,
                                        amountAfterTax: plan.rateRange.low.amountAfterTax,
                                        basePlusExcludedFeesAmount: plan.rateRange.low.basePlusExcludedFeesAmount
                                    };
                                }
                                if (plan.rateRange.high) {
                                    planData.rateRange.high = {
                                        baseAmount: plan.rateRange.high.baseAmount,
                                        excludedFeeSubTotal: plan.rateRange.high.excludedFeeSubTotal,
                                        excludedTaxSubTotal: plan.rateRange.high.excludedTaxSubTotal,
                                        amountAfterTax: plan.rateRange.high.amountAfterTax,
                                        basePlusExcludedFeesAmount: plan.rateRange.high.basePlusExcludedFeesAmount
                                    };
                                }
                            }

                            return planData;
                        });
                }

                // Update cache entry
                hotelCache.set(hotelCode, {
                    apiData,
                    apiTimestamp: Date.now()
                });

                log('Stored API data for', hotelCode, '| Currency:', apiData.propertyCurrency,
                    '| Points:', apiData.lowestPointsOnlyCost?.points,
                    '| Cash:', apiData.lowestCashOnlyCost?.amountAfterTax,
                    '| Rate plans:', apiData.ratePlanDefinitions?.length || 0);
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

    // Get points earned per dollar for current elite status
    function getPointsPerDollar() {
        const level = getUserEliteLevel();
        return CONFIG.IHG.pointsPerDollar[level] || CONFIG.IHG.pointsPerDollar['CLUB'];
    }

    // Calculate net cash cost after cashback
    // totalUSD: total price including taxes and fees (amountAfterTax)
    // roomRateUSD: base room rate (baseAmount) - points are earned on this
    function calculateNetCashCost(totalUSD, roomRateUSD) {
        const cashback = totalUSD * CONFIG.IHG.cashbackRate;
        const pointsEarned = roomRateUSD * getPointsPerDollar();
        const netCost = totalUSD - cashback;

        return {
            grossCost: totalUSD,
            cashback: cashback,
            pointsEarned: pointsEarned,
            netCost: netCost
        };
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

    function isGoodValue(cpp, threshold) {
        return cpp !== null && cpp >= threshold;
    }

    // Calculate the effective cost of redeeming points
    // Uses user's personal point valuation
    function calculatePointsEffectiveCost(points) {
        if (!points || points <= 0) return null;
        // pointValue is in cents, convert to dollars
        return points * CONFIG.IHG.pointValue / 100;
    }

    // Calculate net cash cost including value of earned points
    // This gives the "true" cost after accounting for cashback and point earnings
    function calculateCashEffectiveCost(totalUSD, roomRateUSD) {
        const cashback = totalUSD * CONFIG.IHG.cashbackRate;
        const pointsEarned = roomRateUSD * getPointsPerDollar();
        const pointsValue = pointsEarned * CONFIG.IHG.pointValue / 100; // value in dollars
        const effectiveCost = totalUSD - cashback - pointsValue;

        return {
            grossCost: totalUSD,
            cashback: cashback,
            pointsEarned: pointsEarned,
            pointsValue: pointsValue,
            effectiveCost: effectiveCost
        };
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
    // Returns: { rateCode, bonusPoints, totalUSD, roomRateUSD, effectiveCost, effectiveCalc }
    function findBestCashRate(apiData, convertFn) {
        const candidates = [];

        // Always include the lowest cash rate as baseline
        if (apiData.lowestCashOnlyCost) {
            const cash = apiData.lowestCashOnlyCost;
            const totalUSD = convertFn(cash.amountAfterTax);
            const roomRateUSD = convertFn(cash.baseAmount);

            if (totalUSD !== null && roomRateUSD !== null) {
                const effectiveCalc = calculateCashEffectiveCostWithBonus(totalUSD, roomRateUSD, 0);
                candidates.push({
                    rateCode: 'lowest',
                    bonusPoints: 0,
                    totalUSD,
                    roomRateUSD,
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

                if (totalUSD !== null && roomRateUSD !== null) {
                    const effectiveCalc = calculateCashEffectiveCostWithBonus(totalUSD, roomRateUSD, bonusPoints);
                    candidates.push({
                        rateCode: plan.code,
                        bonusPoints,
                        totalUSD,
                        roomRateUSD,
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

    // Calculate cash effective cost with bonus points
    function calculateCashEffectiveCostWithBonus(totalUSD, roomRateUSD, bonusPoints) {
        const cashback = totalUSD * CONFIG.IHG.cashbackRate;
        const basePointsEarned = roomRateUSD * getPointsPerDollar();
        const totalPointsEarned = basePointsEarned + bonusPoints;
        const pointsValue = totalPointsEarned * CONFIG.IHG.pointValue / 100;
        const effectiveCost = totalUSD - cashback - pointsValue;

        return {
            grossCost: totalUSD,
            cashback: cashback,
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
            const bestCashRate = findBestCashRate(apiData, convertFn);
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
                // Net cost = gross - cashback (don't subtract points value for CPP)
                const netCashCost = effCalc.grossCost - effCalc.cashback;
                // Net points = points to redeem + total points earned (base + bonus)
                netPoints = points + effCalc.totalPointsEarned;
                cpp = calculateCPP(netCashCost, points, effCalc.totalPointsEarned);
                isGood = isGoodValue(cpp, CONFIG.IHG.pointValue);
            }

            const eliteLevel = getUserEliteLevel();

            log('Hotel:', hotelCode,
                '| Type:', points ? 'points+cash' : 'cash-only',
                '| CPP:', cpp?.toFixed(2) || 'N/A',
                '| Best rate:', bestRateInfo?.bestRate || 'N/A',
                '| Best cash:', bestCashRate.rateCode,
                bestCashRate.bonusPoints > 0 ? `(+${bestCashRate.bonusPoints})` : '',
                '| Cash eff:', bestCashRate.effectiveCost.toFixed(2),
                '| Points eff:', pointsEffectiveCost?.toFixed(2) || 'N/A',
                '| Elite:', eliteLevel);

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
                const netCost = (calc.grossCost - calc.cashback).toFixed(0);
                const grossCost = calc.grossCost.toFixed(0);
                const cashback = calc.cashback.toFixed(0);
                const totalPointsEarned = calc.totalPointsEarned.toFixed(0);
                const netPoints = cashData.netPoints.toFixed(0);
                const redeemPoints = cashData.points.toFixed(0);

                let tooltip = `Best cash rate: ${cashData.bestCashRate.rateCode}`;
                if (calc.bonusPoints > 0) {
                    tooltip += ` (+${calc.bonusPoints.toLocaleString()} bonus)`;
                }
                tooltip += `\n  Gross: $${grossCost}\n`;
                tooltip += `  Cashback (${(CONFIG.IHG.cashbackRate * 100).toFixed(0)}%): -$${cashback}\n`;
                tooltip += `  Net cost: $${netCost}\n`;
                tooltip += `  Points earned: ${totalPointsEarned}`;
                if (calc.bonusPoints > 0) {
                    tooltip += ` (${calc.basePointsEarned.toFixed(0)} base + ${calc.bonusPoints} bonus)`;
                }
                tooltip += `\n\nPoints booking:\n`;
                tooltip += `  Points needed: ${redeemPoints}\n`;
                tooltip += `  Foregone earnings: ${totalPointsEarned}\n`;
                tooltip += `  Net points: ${netPoints}\n\n`;
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
                ? ` (+${(bonusPoints / 1000).toFixed(0)}k)`
                : '';
            const cashCostStr = bestRateInfo.cashCost !== null ? `$${bestRateInfo.cashCost.toFixed(0)}` : 'N/A';
            const pointsCostStr = bestRateInfo.pointsCost !== null ? `$${bestRateInfo.pointsCost.toFixed(0)}` : 'N/A';

            if (bestRateInfo.bestRate === 'points' && bestRateInfo.pointsCost !== null) {
                // Points is better
                bestRow.innerHTML = `<span class="best">Points ${pointsCostStr}</span> <span class="alt">vs Cash${bonusLabel} ${cashCostStr}</span>`;
                if (bestRateInfo.savings !== null && bestRateInfo.savings > 0) {
                    bestRow.innerHTML += ` <span class="savings">(save $${bestRateInfo.savings.toFixed(0)})</span>`;
                }
            } else if (bestRateInfo.bestRate === 'cash') {
                // Cash is better (or only option)
                if (bestRateInfo.pointsCost !== null) {
                    bestRow.innerHTML = `<span class="best">Cash${bonusLabel} ${cashCostStr}</span> <span class="alt">vs Points ${pointsCostStr}</span>`;
                    if (bestRateInfo.savings !== null && bestRateInfo.savings > 0) {
                        bestRow.innerHTML += ` <span class="savings">(save $${bestRateInfo.savings.toFixed(0)})</span>`;
                    }
                } else {
                    // Only cash available
                    bestRow.innerHTML = `<span class="best">Cash${bonusLabel} ${cashCostStr}</span> <span class="alt">(no points rate)</span>`;
                }
            }

            // Add tooltip explaining the effective costs
            const effCalc = cashData.cashEffectiveCalc;
            let tooltip = `Effective cost comparison:\n\n`;
            tooltip += `Best cash rate: ${bestCashRate?.rateCode || 'lowest'}`;
            if (bonusPoints > 0) {
                tooltip += ` (+${bonusPoints.toLocaleString()} bonus pts)`;
            }
            tooltip += `\n`;
            tooltip += `  Gross: $${effCalc.grossCost.toFixed(0)}\n`;
            tooltip += `  Cashback (${(CONFIG.IHG.cashbackRate * 100).toFixed(0)}%): -$${effCalc.cashback.toFixed(0)}\n`;
            if (effCalc.basePointsEarned !== undefined) {
                tooltip += `  Base points: ${effCalc.basePointsEarned.toFixed(0)}\n`;
                if (bonusPoints > 0) {
                    tooltip += `  Bonus points: +${bonusPoints}\n`;
                }
                tooltip += `  Total points: ${effCalc.totalPointsEarned.toFixed(0)}\n`;
            } else {
                tooltip += `  Points earned: ${effCalc.pointsEarned?.toFixed(0) || 0}\n`;
            }
            tooltip += `  Points value (${CONFIG.IHG.pointValue}¢/pt): -$${effCalc.pointsValue.toFixed(0)}\n`;
            tooltip += `  Effective cost: $${effCalc.effectiveCost.toFixed(0)}\n\n`;

            if (bestRateInfo.pointsCost !== null && cashData.points) {
                tooltip += `Points redemption:\n`;
                tooltip += `  Points to redeem: ${cashData.points.toLocaleString()}\n`;
                tooltip += `  Point value (${CONFIG.IHG.pointValue}¢/pt): $${bestRateInfo.pointsCost.toFixed(0)}\n`;
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
    // INITIALIZATION
    // ============================================
    function init() {
        log('StayValue v1.11.0 initializing...');
        log('Point valuation:', CONFIG.IHG.pointValue, 'cpp');
        log('Cashback rate:', (CONFIG.IHG.cashbackRate * 100) + '%');
        log('Default elite status:', CONFIG.IHG.defaultEliteStatus);

        injectStyles();
        loadUserProfileFromStorage();
        loadCurrencyRatesFromStorage();
        loadHotelCacheFromStorage();
        setupNetworkInterception();

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
