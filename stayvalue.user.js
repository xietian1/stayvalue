// ==UserScript==
// @name         StayValue
// @namespace    https://github.com/chaoxu/stayvalue
// @version      1.7.0
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
            currency: 'USD'
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

    function calculateCPP(cashRate, points) {
        if (!cashRate || !points || points === 0) return null;
        // cpp = (cash in cents) / points
        return (cashRate * 100) / points;
    }

    function formatCPP(cpp) {
        if (cpp === null) return '';
        return cpp.toFixed(2) + ' cpp';
    }

    function isGoodValue(cpp, threshold) {
        return cpp !== null && cpp >= threshold;
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
            const cashData = apiData.lowestCashOnlyCost;

            if (!points || !cashData) {
                log('Missing points or cash data for:', hotelCode);
                return;
            }

            // Convert cash to USD
            let cashTotalUSD = null;
            let cashRoomUSD = null;
            let cashFeesUSD = null;
            let cashTaxesUSD = null;

            if (currency === 'USD') {
                cashTotalUSD = parseFloat(cashData.amountAfterTax);
                cashRoomUSD = parseFloat(cashData.baseAmount);
                cashFeesUSD = parseFloat(cashData.excludedFeeSubTotal);
                cashTaxesUSD = parseFloat(cashData.excludedTaxSubTotal);
            } else {
                cashTotalUSD = convertToUSD(cashData.amountAfterTax, currency);
                if (cashTotalUSD !== null) {
                    cashRoomUSD = convertToUSD(cashData.baseAmount, currency);
                    cashFeesUSD = convertToUSD(cashData.excludedFeeSubTotal, currency);
                    cashTaxesUSD = convertToUSD(cashData.excludedTaxSubTotal, currency);
                } else {
                    needsCurrencyRate.add(currency);
                    log('Waiting for exchange rate:', currency, '-> USD for', hotelCode);
                    return;
                }
            }

            // Calculate CPP
            const cpp = calculateCPP(cashTotalUSD, points);
            if (cpp === null) {
                log('Could not calculate CPP for:', hotelCode);
                return;
            }

            const isGood = isGoodValue(cpp, CONFIG.IHG.pointValue);
            log('CPP:', cpp.toFixed(2), 'for', hotelCode,
                '| USD:', cashTotalUSD.toFixed(2),
                '| Points:', points,
                '| Currency:', currency,
                '| Good:', isGood);

            // Inject CPP display
            injectCPPDisplay(card, hotelCode, cpp, {
                cashTotalUSD,
                cashRoomUSD,
                cashFeesUSD,
                cashTaxesUSD,
                originalCurrency: currency,
                originalTotal: parseFloat(cashData.amountAfterTax),
                points
            }, isGood);

            card.setAttribute('data-stayvalue-processed', 'true');
            processed++;
        });

        if (processed > 0) {
            showInfo(`StayValue: Calculated cpp for ${processed} hotels`);
        } else if (needsCurrencyRate.size > 0) {
            showInfo(`StayValue: Waiting for exchange rate (${Array.from(needsCurrencyRate).join(', ')})`);
        } else if (hotelCache.size === 0) {
            log('No hotel data cached yet');
        }
    }

    function injectCPPDisplay(card, hotelCode, cpp, cashData, isGood) {
        // Find the points container to append to
        const pointsContainer = card.querySelector('app-hotel-point, .point-container');
        if (!pointsContainer) {
            log('Could not find points container for:', hotelCode);
            return;
        }

        // Check if already injected
        if (pointsContainer.querySelector('.stayvalue-cpp')) {
            return;
        }

        // Create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'stayvalue-display';
        wrapper.style.cssText = 'display: flex; align-items: center; flex-wrap: wrap; margin-top: 4px;';

        // CPP element
        const cppEl = createCPPElement(cpp, isGood);
        wrapper.appendChild(cppEl);

        // Badge if good value
        if (isGood) {
            wrapper.appendChild(createBadge());
        }

        // Cash rate note with breakdown (in USD)
        const note = document.createElement('span');
        note.className = 'stayvalue-cash-note';

        const usdTotal = cashData.cashTotalUSD.toFixed(0);

        // Build breakdown string (room + fees + taxes)
        let breakdown = '';
        if (cashData.cashRoomUSD && cashData.cashFeesUSD) {
            const room = cashData.cashRoomUSD.toFixed(0);
            const fees = cashData.cashFeesUSD.toFixed(0);
            const taxes = cashData.cashTaxesUSD ? cashData.cashTaxesUSD.toFixed(0) : null;
            if (taxes) {
                breakdown = ` (${room}+${fees}+${taxes})`;
            } else {
                breakdown = ` (${room}+${fees})`;
            }
        }

        // Show original currency if converted
        let conversionNote = '';
        if (cashData.originalCurrency && cashData.originalCurrency !== 'USD') {
            conversionNote = ` [${cashData.originalCurrency} ${cashData.originalTotal.toFixed(0)}]`;
        }

        note.textContent = `vs $${usdTotal}${breakdown}${conversionNote}`;
        wrapper.appendChild(note);

        // Append after points container
        pointsContainer.parentNode.insertBefore(wrapper, pointsContainer.nextSibling);
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
        log('StayValue v1.7.0 initializing...');
        log('Point valuation set to:', CONFIG.IHG.pointValue, 'cpp');

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
