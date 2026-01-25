// ==UserScript==
// @name         StayValue
// @namespace    https://github.com/chaoxu/stayvalue
// @version      2.2.0
// @description  Compare hotel point rates vs cash rates - shows cents-per-point (cpp) and highlights better value
// @match        https://www.ihg.com/*
// @match        https://www.marriott.com/*
// @match        https://www.hyatt.com/*
// @match        https://www.hilton.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.exchangerate-api.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // USER CONFIGURATION
    // ============================================
    // Global settings (same across all chains)
    const GLOBAL_CONFIG = {
        dollarDecimals: GM_getValue('dollarDecimals', 0),
        iataCode: GM_getValue('iataCode', '')
    };

    // Chain-specific config defaults
    const CHAIN_CONFIG_DEFAULTS = {
        IHG: { pointValue: 0.5, cashbackRate: 0.05, travelAgentRebateRate: 0.07 },
        Marriott: { pointValue: 0.7, cashbackRate: 0.05, travelAgentRebateRate: 0.07 },
        Hyatt: { pointValue: 1.7, cashbackRate: 0.05, travelAgentRebateRate: 0.07 },
        Hilton: { pointValue: 0.5, cashbackRate: 0.05, travelAgentRebateRate: 0.07 }
    };

    // Get chain-specific config value
    function getChainConfig(chainName) {
        const defaults = CHAIN_CONFIG_DEFAULTS[chainName] || CHAIN_CONFIG_DEFAULTS.IHG;
        const prefix = chainName.toLowerCase();
        return {
            pointValue: GM_getValue(`${prefix}_pointValue`, defaults.pointValue),
            cashbackRate: GM_getValue(`${prefix}_cashbackRate`, defaults.cashbackRate),
            travelAgentRebateRate: GM_getValue(`${prefix}_travelAgentRebateRate`, defaults.travelAgentRebateRate)
        };
    }

    const CONFIG = {
        debug: false
    };

    // ============================================
    // HOTEL CHAIN ADAPTERS
    // ============================================

    const IHGAdapter = {
        name: 'IHG',
        programName: 'IHG One Rewards',
        match: /ihg\.com/,
        chainConfig: null, // Will be initialized on load

        // Points earning configuration
        brandBasePoints: {
            'default': 10,
            'CDLW': 5,    // Candlewood Suites
            'STAY': 5     // Staybridge Suites
        },
        eliteBonusRates: {
            'CLUB': 0,
            'SILVER': 0.2,
            'GOLD': 0.4,
            'PLATINUM': 0.6,
            'DIAMOND': 1.0
        },
        defaultEliteStatus: 'DIAMOND',
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
        },

        // DOM selectors
        selectors: {
            hotelCard: 'app-hotel-card-list-view',
            priceContainer: ['app-hotel-point', 'app-hotel-cash'],
            iataInput: 'input[name="iata"]'
        },

        // API URL patterns
        apiPatterns: {
            availability: 'apis.ihg.com/availability/v3/hotels/offers',
            profile: 'apis.ihg.com/members/v2/profiles/me',
            currency: 'apis.ihg.com/finance/conversions/v2/currencies'
        },

        // Get hotel code from card element
        getHotelCodeFromCard(card) {
            return card.id || card.getAttribute('data-testid')?.replace('hotel-card-', '');
        },

        // Find price container in card
        findPriceContainer(card) {
            for (const selector of this.selectors.priceContainer) {
                const container = card.querySelector(selector);
                if (container) return container;
            }
            return null;
        },

        // Get points per dollar for brand and elite level
        getPointsPerDollar(brandCode, eliteLevel) {
            const basePoints = this.brandBasePoints[brandCode] || this.brandBasePoints['default'];
            const bonusRate = this.eliteBonusRates[eliteLevel] ?? this.eliteBonusRates['CLUB'];
            return basePoints * (1 + bonusRate);
        },

        // Get bonus points for a rate code
        getBonusPoints(rateCode) {
            return this.bonusPointsRates[rateCode] || 0;
        },

        // Parse availability API response
        parseAvailabilityResponse(data) {
            if (!data?.hotels || !Array.isArray(data.hotels)) {
                return [];
            }

            return data.hotels.map(hotel => {
                const hotelData = {
                    hotelCode: hotel.hotelMnemonic,
                    brandCode: hotel.brandCode,
                    currency: hotel.propertyCurrency,
                    lowestCash: null,
                    lowestPoints: null,
                    ratePlans: []
                };

                if (hotel.lowestCashOnlyCost) {
                    hotelData.lowestCash = {
                        total: hotel.lowestCashOnlyCost.amountAfterTax,
                        roomRate: hotel.lowestCashOnlyCost.baseAmount,
                        fees: hotel.lowestCashOnlyCost.excludedFeeSubTotal || 0,
                        taxes: hotel.lowestCashOnlyCost.excludedTaxSubTotal || 0
                    };
                }

                if (hotel.lowestPointsOnlyCost) {
                    hotelData.lowestPoints = hotel.lowestPointsOnlyCost.points;
                }

                if (hotel.ratePlanDefinitions && Array.isArray(hotel.ratePlanDefinitions)) {
                    hotelData.ratePlans = hotel.ratePlanDefinitions
                        .filter(plan => plan.rateRange?.low)
                        .map(plan => ({
                            code: plan.code,
                            total: plan.rateRange.low.amountAfterTax,
                            roomRate: plan.rateRange.low.baseAmount,
                            fees: plan.rateRange.low.excludedFeeSubTotal || 0,
                            taxes: plan.rateRange.low.excludedTaxSubTotal || 0
                        }));
                }

                return hotelData;
            }).filter(h => h.hotelCode);
        },

        // Parse profile API response
        parseProfileResponse(data) {
            const profile = {
                eliteLevel: this.defaultEliteStatus,
                pointsBalance: null
            };

            if (data?.programs && Array.isArray(data.programs)) {
                const pcProgram = data.programs.find(p => p.programCode === 'PC');
                if (pcProgram) {
                    profile.eliteLevel = pcProgram.levelCode || this.defaultEliteStatus;
                    profile.pointsBalance = pcProgram.currentPointsBalance;
                    profile.levelDescription = pcProgram.levelDescription;
                }
            }

            return profile;
        },

        // Parse currency conversion response
        parseCurrencyResponse(data) {
            if (!data?.fromCurrency || !data?.toCurrency || !data?.results) {
                return null;
            }

            const pResult = data.results.find(r => r.source === 'P');
            if (!pResult) return null;

            return {
                from: data.fromCurrency.code,
                to: data.toCurrency.code,
                rate: pResult.result
            };
        },

        // Check which API type a URL matches
        getApiType(url) {
            if (url.includes(this.apiPatterns.availability)) return 'availability';
            if (url.includes(this.apiPatterns.profile)) return 'profile';
            if (url.includes(this.apiPatterns.currency)) return 'currency';
            return null;
        }
    };

    const MarriottAdapter = {
        name: 'Marriott',
        programName: 'Marriott Bonvoy',
        match: /marriott\.com/,
        chainConfig: null,

        // Points earning: 10 pts/$ for most brands, 5 pts/$ for extended stay, 2.5 for Homes & Villas
        // Brand codes from API (e.g., XF = Four Points Flex, RI = Residence Inn)
        brandBasePoints: {
            'default': 10,
            // Extended stay brands (5 pts/$)
            'RI': 5,    // Residence Inn
            'TS': 5,    // TownePlace Suites
            'EL': 5,    // Element
            'EX': 5,    // Executive Apartments
            // Homes & Villas (2.5 pts/$)
            'HV': 2.5
        },
        eliteBonusRates: {
            'Member': 0,
            'Silver': 0.1,
            'Gold': 0.25,
            'Platinum': 0.5,
            'Titanium': 0.75,
            'Ambassador': 0.75
        },
        defaultEliteStatus: 'Platinum',
        bonusPointsRates: {},

        // DOM selectors
        selectors: {
            hotelCard: '.property-card-container',
            priceContainer: ['div.rate-container', 'div.price-sub-section'],
            iataInput: 'input#iata[data-testid="iata"]'
        },

        // API URL patterns
        apiPatterns: {
            availability: 'marriott.com/mi/query/phoenixShopDatedSearchByGeoQuery',
            profile: 'marriott.com/hybrid-presentation/api/v1/getUserDetails',
            currency: null  // Using global exchange rate API
        },

        // Get hotel code from card element
        getHotelCodeFromCard(card) {
            // Try to find propertyCode in any link within the card
            const link = card.querySelector('a[href*="propertyCode="]');
            if (link) {
                const match = link.href.match(/propertyCode=([A-Z0-9]+)/i);
                if (match) return match[1];
            }
            // Try data attribute
            const codeAttr = card.getAttribute('data-property-code') || card.getAttribute('data-marsha-code');
            if (codeAttr) return codeAttr;
            return null;
        },

        // Find price container in card
        findPriceContainer(card) {
            for (const selector of this.selectors.priceContainer) {
                const container = card.querySelector(selector);
                if (container) return container;
            }
            return null;
        },


        // Get points per dollar for brand and elite level
        getPointsPerDollar(brandCode, eliteLevel) {
            const basePoints = this.brandBasePoints[brandCode] || this.brandBasePoints['default'];
            const bonusRate = this.eliteBonusRates[eliteLevel] ?? 0;
            return basePoints * (1 + bonusRate);
        },

        // Get bonus points for a rate code (Marriott doesn't have the same bonus point system as IHG)
        getBonusPoints(rateCode) {
            return 0;
        },

        // Parse availability API response (GraphQL)
        parseAvailabilityResponse(data) {
            // Navigate to edges array
            const edges = data?.data?.search?.lowestAvailableRates?.searchByGeolocation?.edges;
            if (!edges || !Array.isArray(edges)) {
                return [];
            }

            return edges.map(edge => {
                const node = edge.node;
                if (!node?.property?.id) return null;

                const property = node.property;
                const basicInfo = property.basicInformation || {};
                const rates = node.rates || [];

                const hotelData = {
                    hotelCode: property.id,
                    brandCode: basicInfo.brand?.id || 'default',
                    brandName: basicInfo.brand?.name || '',
                    currency: basicInfo.currency || 'USD',
                    hotelName: basicInfo.name || '',
                    lowestCash: null,
                    lowestPoints: null,
                    lengthOfStay: null,
                    ratePlans: []
                };

                // Process rates
                for (const rate of rates) {
                    if (rate.status?.code !== 'AvailableForSale') continue;

                    const lengthOfStay = rate.lengthOfStay || 1;
                    hotelData.lengthOfStay = lengthOfStay;

                    // Points rate
                    if (rate.rateModes?.pointsPerUnit?.points) {
                        const totalPoints = rate.rateModes.pointsPerUnit.points;
                        // Convert to per-night points
                        hotelData.lowestPoints = Math.round(totalPoints / lengthOfStay);
                    }

                    // Cash rate (StandardRates)
                    if (rate.rateCategory?.code === 'StandardRates' && rate.rateModes?.lowestAverageRate) {
                        const cashRate = rate.rateModes.lowestAverageRate;
                        hotelData.lowestCash = {
                            // Per night values
                            roomRate: cashRate.amount?.amount || 0,
                            fees: cashRate.fees?.amount || 0,
                            mandatoryFees: cashRate.mandatoryFees?.amount || 0,
                            taxes: cashRate.taxes?.amount || 0,
                            total: cashRate.totalAmount?.amount || 0,
                            // Also store amountPlusMandatoryFees for reference
                            amountPlusMandatoryFees: cashRate.amountPlusMandatoryFees?.amount || 0
                        };
                    }
                }

                return hotelData;
            }).filter(h => h !== null && h.hotelCode);
        },

        // Parse profile API response
        parseProfileResponse(data) {
            const profile = {
                eliteLevel: this.defaultEliteStatus,
                pointsBalance: null,
                levelDescription: null
            };

            if (data?.status === 'success' && data?.userProfileSummary) {
                const summary = data.userProfileSummary;

                // Extract elite level (e.g., "Titanium Elite" -> "Titanium")
                if (summary.level) {
                    profile.levelDescription = summary.level;
                    // Remove " Elite" suffix to match our eliteBonusRates keys
                    const levelKey = summary.level.replace(/\s*Elite$/i, '');
                    if (this.eliteBonusRates[levelKey] !== undefined) {
                        profile.eliteLevel = levelKey;
                    }
                }

                // Extract points balance (e.g., "19,799" -> 19799)
                if (summary.currentPoints) {
                    const points = parseInt(summary.currentPoints.replace(/,/g, ''), 10);
                    if (!isNaN(points)) {
                        profile.pointsBalance = points;
                    }
                }
            }

            return profile;
        },

        // Parse currency conversion response
        parseCurrencyResponse(data) {
            // TODO: Implement when we find currency API
            return null;
        },

        // Check which API type a URL matches
        getApiType(url) {
            if (this.apiPatterns.availability && url.includes(this.apiPatterns.availability)) return 'availability';
            if (this.apiPatterns.profile && url.includes(this.apiPatterns.profile)) return 'profile';
            if (this.apiPatterns.currency && url.includes(this.apiPatterns.currency)) return 'currency';
            return null;
        }
    };

    const HyattAdapter = {
        name: 'Hyatt',
        programName: 'World of Hyatt',
        match: /hyatt\.com/,
        chainConfig: null,
        brandBasePoints: { 'default': 5, 'Hyatt Studios': 2.5 },
        eliteBonusRates: { 'Member': 0, 'Discoverist': 0.1, 'Explorist': 0.2, 'Globalist': 0.3 },
        defaultEliteStatus: 'Globalist',
        bonusPointsRates: {},
        selectors: { hotelCard: null, priceContainer: [], iataInput: null },
        apiPatterns: { availability: null, profile: null, currency: null },
        getHotelCodeFromCard(card) { return null; },
        findPriceContainer(card) { return null; },
        getPointsPerDollar(brandCode, eliteLevel) {
            const basePoints = this.brandBasePoints[brandCode] || this.brandBasePoints['default'];
            const bonusRate = this.eliteBonusRates[eliteLevel] ?? 0;
            return basePoints * (1 + bonusRate);
        },
        getBonusPoints(rateCode) { return 0; },
        parseAvailabilityResponse(data) { return []; },
        parseProfileResponse(data) { return { eliteLevel: this.defaultEliteStatus, pointsBalance: null }; },
        parseCurrencyResponse(data) { return null; },
        getApiType(url) { return null; }
    };

    const HiltonAdapter = {
        name: 'Hilton',
        programName: 'Hilton Honors',
        match: /hilton\.com/,
        chainConfig: null,
        brandBasePoints: { 'default': 10, 'Home2 Suites': 5, 'Tru': 5, 'LivSmart Studios': 3 },
        eliteBonusRates: { 'Member': 0, 'Silver': 0.2, 'Gold': 0.8, 'Diamond': 1.0 },
        defaultEliteStatus: 'Diamond',
        bonusPointsRates: {},
        selectors: { hotelCard: null, priceContainer: [], iataInput: null },
        apiPatterns: { availability: null, profile: null, currency: null },
        getHotelCodeFromCard(card) { return null; },
        findPriceContainer(card) { return null; },
        getPointsPerDollar(brandCode, eliteLevel) {
            const basePoints = this.brandBasePoints[brandCode] || this.brandBasePoints['default'];
            const bonusRate = this.eliteBonusRates[eliteLevel] ?? 0;
            return basePoints * (1 + bonusRate);
        },
        getBonusPoints(rateCode) { return 0; },
        parseAvailabilityResponse(data) { return []; },
        parseProfileResponse(data) { return { eliteLevel: this.defaultEliteStatus, pointsBalance: null }; },
        parseCurrencyResponse(data) { return null; },
        getApiType(url) { return null; }
    };

    // All adapters
    const ADAPTERS = [IHGAdapter, MarriottAdapter, HyattAdapter, HiltonAdapter];

    // Detect current adapter based on URL
    function detectAdapter() {
        const hostname = location.hostname;
        for (const adapter of ADAPTERS) {
            if (adapter.match.test(hostname)) {
                // Load chain-specific config
                adapter.chainConfig = getChainConfig(adapter.name);
                return adapter;
            }
        }
        return null;
    }

    // Current active adapter
    const activeAdapter = detectAdapter();

    // ============================================
    // SHARED STATE
    // ============================================
    let userProfile = {
        eliteLevel: activeAdapter?.defaultEliteStatus || 'Member',
        pointsBalance: null,
        levelDescription: null
    };

    const currencyRates = new Map();
    const hotelCache = new Map();

    // ============================================
    // MENU COMMANDS
    // ============================================
    function setupMenuCommands() {
        if (!activeAdapter) return;

        const chainName = activeAdapter.name;
        const chainConfig = activeAdapter.chainConfig;
        const prefix = chainName.toLowerCase();

        GM_registerMenuCommand(`[${chainName}] Set Point Value (current: ${chainConfig.pointValue}¢)`, () => {
            const value = prompt(`Enter your ${chainName} point valuation in cents (e.g., 0.5 for half a cent):`, chainConfig.pointValue);
            if (value !== null) {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 0) {
                    GM_setValue(`${prefix}_pointValue`, num);
                    alert(`${chainName} point value set to ${num}¢. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter a number >= 0.');
                }
            }
        });

        GM_registerMenuCommand(`[${chainName}] Set Cashback Rate (current: ${(chainConfig.cashbackRate * 100).toFixed(1)}%)`, () => {
            const value = prompt(`Enter your ${chainName} cashback rate as a percentage (e.g., 5 for 5%):`, chainConfig.cashbackRate * 100);
            if (value !== null) {
                const num = parseFloat(value) / 100;
                if (!isNaN(num) && num >= 0 && num <= 1) {
                    GM_setValue(`${prefix}_cashbackRate`, num);
                    alert(`${chainName} cashback rate set to ${(num * 100).toFixed(1)}%. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter a percentage between 0 and 100.');
                }
            }
        });

        GM_registerMenuCommand(`[${chainName}] Set TA Rebate (current: ${(chainConfig.travelAgentRebateRate * 100).toFixed(1)}%)`, () => {
            const value = prompt(`Enter ${chainName} travel agent rebate rate as a percentage (e.g., 7 for 7%, 0 to disable):`, chainConfig.travelAgentRebateRate * 100);
            if (value !== null) {
                const num = parseFloat(value) / 100;
                if (!isNaN(num) && num >= 0 && num <= 1) {
                    GM_setValue(`${prefix}_travelAgentRebateRate`, num);
                    alert(`${chainName} travel agent rebate set to ${(num * 100).toFixed(1)}%. Refresh the page to apply.`);
                } else {
                    alert('Invalid value. Please enter a percentage between 0 and 100.');
                }
            }
        });

        GM_registerMenuCommand(`Set Dollar Decimals (current: ${GLOBAL_CONFIG.dollarDecimals})`, () => {
            const value = prompt('Enter number of decimal places for dollar amounts (0, 1, or 2):', GLOBAL_CONFIG.dollarDecimals);
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

        GM_registerMenuCommand(`Set IATA Code (current: ${GLOBAL_CONFIG.iataCode || 'not set'})`, () => {
            const value = prompt('Enter your IATA code (e.g., 99634986):', GLOBAL_CONFIG.iataCode);
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
    // STORAGE FUNCTIONS
    // ============================================
    function loadFromStorage() {
        try {
            // Load user profile
            const storedProfile = sessionStorage.getItem('stayvalue_profile');
            if (storedProfile) {
                const data = JSON.parse(storedProfile);
                if (data.timestamp && Date.now() - data.timestamp < 3600000) {
                    userProfile = { ...data.profile };
                    log('Loaded profile from storage:', userProfile);
                }
            }

            // Load currency rates
            const storedCurrency = sessionStorage.getItem('stayvalue_currencies');
            if (storedCurrency) {
                const data = JSON.parse(storedCurrency);
                if (data.timestamp && Date.now() - data.timestamp < 86400000) {
                    Object.entries(data.rates || {}).forEach(([key, value]) => {
                        currencyRates.set(key, value);
                    });
                    log('Loaded', currencyRates.size, 'currency rates from storage');
                }
            }

            // Load hotel cache
            const storedHotels = sessionStorage.getItem('stayvalue_hotels');
            if (storedHotels) {
                const data = JSON.parse(storedHotels);
                if (data.timestamp && Date.now() - data.timestamp < 3600000) {
                    Object.entries(data.hotels || {}).forEach(([key, value]) => {
                        hotelCache.set(key, value);
                    });
                    log('Loaded', hotelCache.size, 'hotels from storage');
                }
            }
        } catch (e) {
            log('Error loading from storage:', e);
        }
    }

    function saveProfileToStorage() {
        try {
            sessionStorage.setItem('stayvalue_profile', JSON.stringify({
                profile: userProfile,
                timestamp: Date.now()
            }));
        } catch (e) {
            log('Error saving profile:', e);
        }
    }

    function saveCurrencyRatesToStorage() {
        try {
            sessionStorage.setItem('stayvalue_currencies', JSON.stringify({
                rates: Object.fromEntries(currencyRates),
                timestamp: Date.now()
            }));
        } catch (e) {
            log('Error saving currency rates:', e);
        }
    }

    function saveHotelCacheToStorage() {
        try {
            sessionStorage.setItem('stayvalue_hotels', JSON.stringify({
                hotels: Object.fromEntries(hotelCache),
                timestamp: Date.now()
            }));
        } catch (e) {
            log('Error saving hotel cache:', e);
        }
    }

    // ============================================
    // NETWORK INTERCEPTION
    // ============================================
    function setupNetworkInterception() {
        if (!activeAdapter) return;

        // Method 1: Intercept fetch (works for some sites)
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const url = args[0]?.url || args[0];
            const response = await originalFetch.apply(this, args);

            if (typeof url === 'string') {
                const apiType = activeAdapter.getApiType(url);
                if (apiType) {
                    try {
                        const clone = response.clone();
                        const data = await clone.json();
                        handleApiResponse(apiType, data);
                    } catch (e) {
                        // Silently ignore parse errors
                    }
                }
            }

            return response;
        };

        // Method 2: Intercept Response.prototype.json
        const originalJson = Response.prototype.json;
        Response.prototype.json = async function() {
            const data = await originalJson.apply(this);

            const url = this.url;
            if (url) {
                const apiType = activeAdapter.getApiType(url);
                if (apiType) {
                    handleApiResponse(apiType, data);
                }
            }

            // Check for Marriott GraphQL response structure
            if (data?.data?.search?.lowestAvailableRates?.searchByGeolocation?.edges) {
                handleApiResponse('availability', data);
            }

            return data;
        };

        // Method 3: Intercept JSON.parse (catches responses even with fetch wrappers)
        // Only needed for sites like Marriott where Dynatrace wraps fetch
        if (activeAdapter.name === 'Marriott') {
            const originalJSONParse = JSON.parse;
            JSON.parse = function(text, reviver) {
                const data = originalJSONParse.call(this, text, reviver);

                // Quick exit: only check objects with 'data' property (GraphQL responses)
                if (data && typeof data === 'object' && data.data?.search?.lowestAvailableRates?.searchByGeolocation?.edges) {
                    handleApiResponse('availability', data);
                }

                return data;
            };
        }

        // Method 4: Intercept XHR (fallback)
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
                const apiType = activeAdapter.getApiType(url);
                if (apiType) {
                    this.addEventListener('load', function() {
                        try {
                            const data = JSON.parse(self.responseText);
                            handleApiResponse(apiType, data);
                        } catch (e) {
                            log('Error parsing XHR response:', e);
                        }
                    });
                }
            }
            return originalXHRSend.apply(this, args);
        };

        log('Network interception set up for', activeAdapter.name);
    }

    function handleApiResponse(apiType, data) {
        log('Intercepted', apiType, 'API response');

        switch (apiType) {
            case 'availability':
                const hotels = activeAdapter.parseAvailabilityResponse(data);
                hotels.forEach(hotel => {
                    hotelCache.set(hotel.hotelCode, {
                        data: hotel,
                        timestamp: Date.now()
                    });
                    log('Cached:', hotel.hotelCode, '| Brand:', hotel.brandCode,
                        '| Points:', hotel.lowestPoints || 'N/A',
                        '| Cash:', hotel.lowestCash?.total || 'N/A');
                });
                saveHotelCacheToStorage();
                debouncedProcess();
                break;

            case 'profile':
                const profile = activeAdapter.parseProfileResponse(data);
                userProfile = profile;
                saveProfileToStorage();
                if (profile.levelDescription) {
                    showInfo(`StayValue: ${profile.levelDescription} | ${profile.pointsBalance?.toLocaleString() || 0} pts`);
                }
                break;

            case 'currency':
                const rate = activeAdapter.parseCurrencyResponse(data);
                if (rate) {
                    const key = `${rate.from}_${rate.to}`;
                    currencyRates.set(key, rate.rate);
                    log('Stored currency rate:', key, '=', rate.rate);
                    saveCurrencyRatesToStorage();
                    debouncedProcess();
                }
                break;
        }
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================
    function log(...args) {
        if (CONFIG.debug) {
            console.log('[StayValue]', ...args);
        }
    }

    function fmtDollars(amount) {
        if (amount === null || amount === undefined) return '?';
        return amount.toFixed(GLOBAL_CONFIG.dollarDecimals);
    }

    function fmtPoints(points) {
        if (points === null || points === undefined) return '?';
        return Math.round(points).toLocaleString();
    }

    function fmtPercent(rate) {
        return (rate * 100).toFixed(1);
    }

    function formatCPP(cpp) {
        if (cpp === null) return '';
        return cpp.toFixed(2) + ' cpp';
    }

    // Fallback exchange rates (approximate, used if API fails)
    const FALLBACK_EXCHANGE_RATES = {
        'JPY_USD': 0.0067,   // ~150 JPY = 1 USD
        'EUR_USD': 1.08,
        'GBP_USD': 1.27,
        'CAD_USD': 0.74,
        'AUD_USD': 0.65,
        'CNY_USD': 0.14,
        'KRW_USD': 0.00075,  // ~1333 KRW = 1 USD
        'THB_USD': 0.029,
        'SGD_USD': 0.74,
        'HKD_USD': 0.13,
        'MXN_USD': 0.058,
        'INR_USD': 0.012
    };

    // Fetch exchange rates from free API
    function fetchExchangeRates() {
        // Check if we have recent rates (less than 6 hours old)
        const lastFetch = GM_getValue('exchangeRates_timestamp', 0);
        const SIX_HOURS = 6 * 60 * 60 * 1000;
        if (Date.now() - lastFetch < SIX_HOURS) {
            const storedRates = GM_getValue('exchangeRates', null);
            if (storedRates) {
                Object.entries(storedRates).forEach(([key, value]) => {
                    currencyRates.set(key, value);
                });
                log('Loaded', Object.keys(storedRates).length, 'exchange rates from cache');
                return;
            }
        }

        log('Fetching exchange rates from API...');
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.exchangerate-api.com/v4/latest/USD',
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.rates) {
                        const ratesToStore = {};
                        // Convert rates: API gives USD -> X, we need X -> USD
                        Object.entries(data.rates).forEach(([currency, rate]) => {
                            if (rate > 0) {
                                const key = `${currency}_USD`;
                                const inverseRate = 1 / rate;
                                currencyRates.set(key, inverseRate);
                                ratesToStore[key] = inverseRate;
                            }
                        });
                        // Store in GM storage for persistence
                        GM_setValue('exchangeRates', ratesToStore);
                        GM_setValue('exchangeRates_timestamp', Date.now());
                        log('Fetched', Object.keys(ratesToStore).length, 'exchange rates');
                        // Reprocess hotels with new rates
                        debouncedProcess();
                    }
                } catch (e) {
                    log('Error parsing exchange rate response:', e);
                }
            },
            onerror: function(error) {
                log('Error fetching exchange rates:', error);
            }
        });
    }

    function convertToUSD(amount, fromCurrency) {
        if (!amount || fromCurrency === 'USD') {
            return parseFloat(amount);
        }
        const key = `${fromCurrency}_USD`;
        let rate = currencyRates.get(key);
        if (!rate) {
            // Try fallback rates
            rate = FALLBACK_EXCHANGE_RATES[key];
            if (rate) {
                log('Using fallback exchange rate for', key, '=', rate);
            } else {
                log('No exchange rate found for', key);
                return null;
            }
        }
        return parseFloat(amount) * rate;
    }

    // ============================================
    // CORE CALCULATIONS
    // ============================================
    function calculateCPP(netCashCost, pointsToRedeem, pointsEarned) {
        const netPoints = pointsToRedeem + pointsEarned;
        if (!netCashCost || !netPoints || netPoints <= 0) return null;
        return (netCashCost * 100) / netPoints;
    }

    function calculatePointsEffectiveCost(points) {
        if (!points || points <= 0 || !activeAdapter?.chainConfig) return null;
        return points * activeAdapter.chainConfig.pointValue / 100;
    }

    function calculateCashEffectiveCost(totalUSD, roomRateUSD, bonusPoints, brandCode) {
        const chainConfig = activeAdapter.chainConfig;
        const pointsPerDollar = activeAdapter.getPointsPerDollar(brandCode, userProfile.eliteLevel);
        const cashback = totalUSD * chainConfig.cashbackRate;
        const travelAgentRebate = roomRateUSD * chainConfig.travelAgentRebateRate;
        const basePointsEarned = roomRateUSD * pointsPerDollar;
        const totalPointsEarned = basePointsEarned + bonusPoints;
        const pointsValue = totalPointsEarned * chainConfig.pointValue / 100;
        const effectiveCost = totalUSD - cashback - travelAgentRebate - pointsValue;

        return {
            grossCost: totalUSD,
            roomRate: roomRateUSD,
            cashback,
            travelAgentRebate,
            basePointsEarned,
            bonusPoints,
            totalPointsEarned,
            pointsValue,
            effectiveCost
        };
    }

    function findBestCashRate(hotelData, convertFn) {
        const candidates = [];

        // Lowest cash rate as baseline
        if (hotelData.lowestCash) {
            const cash = hotelData.lowestCash;
            const totalUSD = convertFn(cash.total);
            const roomRateUSD = convertFn(cash.roomRate);
            const feesUSD = convertFn(cash.fees) || 0;
            const taxesUSD = convertFn(cash.taxes) || 0;

            if (totalUSD !== null && roomRateUSD !== null) {
                const effectiveCalc = calculateCashEffectiveCost(totalUSD, roomRateUSD, 0, hotelData.brandCode);
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

        // Check rate plans for bonus points
        if (hotelData.ratePlans) {
            hotelData.ratePlans.forEach(plan => {
                const bonusPoints = activeAdapter.getBonusPoints(plan.code);
                const totalUSD = convertFn(plan.total);
                const roomRateUSD = convertFn(plan.roomRate);
                const feesUSD = convertFn(plan.fees) || 0;
                const taxesUSD = convertFn(plan.taxes) || 0;

                if (totalUSD !== null && roomRateUSD !== null) {
                    const effectiveCalc = calculateCashEffectiveCost(totalUSD, roomRateUSD, bonusPoints, hotelData.brandCode);
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
        candidates.sort((a, b) => a.effectiveCost - b.effectiveCost);
        return candidates[0];
    }

    function determineBestRate(cashEffective, pointsEffectiveCost) {
        if (cashEffective === null && pointsEffectiveCost === null) {
            return null;
        }

        if (pointsEffectiveCost === null) {
            return { bestRate: 'cash', cashCost: cashEffective, pointsCost: null, savings: null };
        }

        if (cashEffective === null) {
            return { bestRate: 'points', cashCost: null, pointsCost: pointsEffectiveCost, savings: null };
        }

        const savings = Math.abs(cashEffective - pointsEffectiveCost);
        if (pointsEffectiveCost < cashEffective) {
            return { bestRate: 'points', cashCost: cashEffective, pointsCost: pointsEffectiveCost, savings };
        } else {
            return { bestRate: 'cash', cashCost: cashEffective, pointsCost: pointsEffectiveCost, savings };
        }
    }

    // ============================================
    // STYLING
    // ============================================
    const STYLES = `
        .stayvalue-cpp { font-size: 12px; color: #666; margin-left: 4px; font-weight: normal; }
        .stayvalue-cpp.good-value { color: #2e7d32; font-weight: 600; }
        .stayvalue-cpp.bad-value { color: #c62828; }
        .stayvalue-badge { display: inline-flex; align-items: center; background: #e8f5e9; color: #2e7d32; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 6px; }
        .stayvalue-badge::before { content: "\\2713 "; }
        .stayvalue-best-rate { font-size: 11px; margin-top: 2px; color: #555; }
        .stayvalue-best-rate .best { font-weight: 600; color: #2e7d32; }
        .stayvalue-best-rate .alt { color: #888; }
        .stayvalue-best-rate .savings { color: #1565c0; font-size: 10px; }
        .stayvalue-info { position: fixed; bottom: 20px; right: 20px; background: #333; color: #fff; padding: 10px 15px; border-radius: 8px; font-size: 12px; z-index: 10000; box-shadow: 0 2px 10px rgba(0,0,0,0.3); }
        .stayvalue-info.hidden { display: none; }
    `;

    function injectStyles() {
        if (document.getElementById('stayvalue-styles')) return;
        const style = document.createElement('style');
        style.id = 'stayvalue-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
        log('Styles injected');
    }

    // ============================================
    // DOM INJECTION
    // ============================================
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

    // ============================================
    // MAIN PROCESSING
    // ============================================
    function processHotelCards() {
        if (!activeAdapter || !activeAdapter.selectors.hotelCard) {
            log('No adapter or hotel card selector available');
            return;
        }

        log('Processing hotel cards...');
        log('Hotel cache has', hotelCache.size, 'entries');

        const cards = document.querySelectorAll(activeAdapter.selectors.hotelCard);
        log('Found', cards.length, 'hotel cards');

        let processed = 0;
        let needsCurrencyRate = new Set();

        cards.forEach(card => {
            if (card.hasAttribute('data-stayvalue-processed')) return;

            const hotelCode = activeAdapter.getHotelCodeFromCard(card);
            if (!hotelCode) {
                log('No hotel code found for card');
                return;
            }

            const cached = hotelCache.get(hotelCode);
            if (!cached?.data) {
                log('No cached data for:', hotelCode);
                return;
            }

            const hotelData = cached.data;
            const currency = hotelData.currency;

            const convertFn = (amount) => {
                if (amount === null || amount === undefined) return null;
                if (currency === 'USD') return parseFloat(amount);
                return convertToUSD(amount, currency);
            };

            if (currency !== 'USD' && !currencyRates.has(`${currency}_USD`)) {
                needsCurrencyRate.add(currency);
                log('Waiting for exchange rate:', currency, '-> USD for', hotelCode);
                return;
            }

            const bestCashRate = findBestCashRate(hotelData, convertFn);
            if (!bestCashRate) {
                log('No valid cash rate for:', hotelCode);
                return;
            }

            const points = hotelData.lowestPoints;
            const pointsEffectiveCost = points ? calculatePointsEffectiveCost(points) : null;
            const bestRateInfo = determineBestRate(bestCashRate.effectiveCost, pointsEffectiveCost);

            if (bestRateInfo) {
                bestRateInfo.bestCashRate = bestCashRate;
            }

            let cpp = null;
            let isGood = false;
            let netPoints = null;

            if (points) {
                const effCalc = bestCashRate.effectiveCalc;
                const netCashCost = effCalc.grossCost - effCalc.cashback - effCalc.travelAgentRebate;
                netPoints = points + effCalc.totalPointsEarned;
                cpp = calculateCPP(netCashCost, points, effCalc.totalPointsEarned);
                isGood = cpp !== null && cpp >= activeAdapter.chainConfig.pointValue;
            }

            log('Hotel:', hotelCode,
                '| Brand:', hotelData.brandCode,
                '| CPP:', cpp?.toFixed(2) || 'N/A',
                '| Best:', bestRateInfo?.bestRate || 'N/A',
                '| Elite:', userProfile.eliteLevel);

            injectDisplay(card, hotelCode, cpp, {
                points,
                netPoints,
                cashEffectiveCalc: bestCashRate.effectiveCalc,
                pointsEffectiveCost,
                bestRateInfo,
                bestCashRate,
                eliteLevel: userProfile.eliteLevel
            }, isGood);

            card.setAttribute('data-stayvalue-processed', 'true');
            processed++;
        });

        if (processed > 0) {
            showInfo(`StayValue: Processed ${processed} hotels`);
        } else if (needsCurrencyRate.size > 0) {
            showInfo(`StayValue: Waiting for exchange rate (${Array.from(needsCurrencyRate).join(', ')})`);
        }
    }

    function injectDisplay(card, hotelCode, cpp, data, isGood) {
        try {
            if (card.querySelector('.stayvalue-display')) return;

            const container = activeAdapter.findPriceContainer(card);
            if (!container) {
                log('Could not find container for:', hotelCode);
                return;
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'stayvalue-display';
            wrapper.style.cssText = 'display: flex; flex-direction: column; margin-top: 4px; align-items: flex-end; text-align: right;';

            // CPP row
            if (cpp !== null && data.cashEffectiveCalc) {
                const cppRow = document.createElement('div');
                cppRow.style.cssText = 'display: flex; align-items: center; flex-wrap: wrap;';

                const cppEl = createCPPElement(cpp, isGood);

                const calc = data.cashEffectiveCalc;
                const best = data.bestCashRate;
                const netCost = calc.grossCost - calc.cashback - calc.travelAgentRebate;

                let grossBreakdown = `$${fmtDollars(best.roomRateUSD)} room`;
                if (best.feesUSD > 0) grossBreakdown += ` + $${fmtDollars(best.feesUSD)} fees`;
                if (best.taxesUSD > 0) grossBreakdown += ` + $${fmtDollars(best.taxesUSD)} tax`;

                let tooltip = `Best cash rate: ${best.rateCode}`;
                if (calc.bonusPoints > 0) tooltip += ` (+${fmtPoints(calc.bonusPoints)} bonus)`;
                tooltip += `\n  Gross: $${fmtDollars(calc.grossCost)} (${grossBreakdown})\n`;
                tooltip += `  Cashback (${fmtPercent(activeAdapter.chainConfig.cashbackRate)}%): -$${fmtDollars(calc.cashback)}\n`;
                if (activeAdapter.chainConfig.travelAgentRebateRate > 0) {
                    tooltip += `  TA Rebate (${fmtPercent(activeAdapter.chainConfig.travelAgentRebateRate)}%): -$${fmtDollars(calc.travelAgentRebate)}\n`;
                }
                tooltip += `  Net cost: $${fmtDollars(netCost)}\n`;
                tooltip += `  Points earned: ${fmtPoints(calc.totalPointsEarned)}`;
                if (calc.bonusPoints > 0) tooltip += ` (${fmtPoints(calc.basePointsEarned)} base + ${fmtPoints(calc.bonusPoints)} bonus)`;
                tooltip += `\n\nPoints booking:\n`;
                tooltip += `  Points needed: ${fmtPoints(data.points)}\n`;
                tooltip += `  Foregone earnings: ${fmtPoints(calc.totalPointsEarned)}\n`;
                tooltip += `  Net points: ${fmtPoints(data.netPoints)}\n\n`;
                tooltip += `Elite: ${data.eliteLevel}`;

                cppEl.title = tooltip;
                cppRow.appendChild(cppEl);

                if (isGood) cppRow.appendChild(createBadge());
                wrapper.appendChild(cppRow);
            }

            // Best rate row
            const bestRateInfo = data.bestRateInfo;
            const bestCashRate = data.bestCashRate;
            if (bestRateInfo) {
                const bestRow = document.createElement('div');
                bestRow.className = 'stayvalue-best-rate';

                const bonusPoints = bestCashRate?.bonusPoints || 0;
                const bonusLabel = bonusPoints > 0 ? ` (+${Math.round(bonusPoints / 1000)}k)` : '';
                const cashCostStr = bestRateInfo.cashCost !== null ? `$${fmtDollars(bestRateInfo.cashCost)}` : 'N/A';
                const pointsCostStr = bestRateInfo.pointsCost !== null ? `$${fmtDollars(bestRateInfo.pointsCost)}` : 'N/A';

                if (bestRateInfo.bestRate === 'points' && bestRateInfo.pointsCost !== null) {
                    bestRow.innerHTML = `<span class="best">Points ${pointsCostStr}</span> <span class="alt">vs Cash${bonusLabel} ${cashCostStr}</span>`;
                    if (bestRateInfo.savings > 0) bestRow.innerHTML += ` <span class="savings">(save $${fmtDollars(bestRateInfo.savings)})</span>`;
                } else if (bestRateInfo.bestRate === 'cash') {
                    if (bestRateInfo.pointsCost !== null) {
                        bestRow.innerHTML = `<span class="best">Cash${bonusLabel} ${cashCostStr}</span> <span class="alt">vs Points ${pointsCostStr}</span>`;
                        if (bestRateInfo.savings > 0) bestRow.innerHTML += ` <span class="savings">(save $${fmtDollars(bestRateInfo.savings)})</span>`;
                    } else {
                        bestRow.innerHTML = `<span class="best">Cash${bonusLabel} ${cashCostStr}</span>`;
                    }
                }

                const effCalc = data.cashEffectiveCalc;
                let grossBreakdown = `$${fmtDollars(bestCashRate?.roomRateUSD)} room`;
                if (bestCashRate?.feesUSD > 0) grossBreakdown += ` + $${fmtDollars(bestCashRate.feesUSD)} fees`;
                if (bestCashRate?.taxesUSD > 0) grossBreakdown += ` + $${fmtDollars(bestCashRate.taxesUSD)} tax`;

                let tooltip = `Effective cost comparison:\n\nBest cash rate: ${bestCashRate?.rateCode || 'lowest'}`;
                if (bonusPoints > 0) tooltip += ` (+${fmtPoints(bonusPoints)} bonus pts)`;
                tooltip += `\n  Gross: $${fmtDollars(effCalc.grossCost)} (${grossBreakdown})\n`;
                tooltip += `  Cashback (${fmtPercent(activeAdapter.chainConfig.cashbackRate)}%): -$${fmtDollars(effCalc.cashback)}\n`;
                if (activeAdapter.chainConfig.travelAgentRebateRate > 0) {
                    tooltip += `  TA Rebate (${fmtPercent(activeAdapter.chainConfig.travelAgentRebateRate)}%): -$${fmtDollars(effCalc.travelAgentRebate)}\n`;
                }
                tooltip += `  Base points: ${fmtPoints(effCalc.basePointsEarned)}\n`;
                if (bonusPoints > 0) tooltip += `  Bonus points: +${fmtPoints(bonusPoints)}\n`;
                tooltip += `  Total points: ${fmtPoints(effCalc.totalPointsEarned)}\n`;
                tooltip += `  Points value (${activeAdapter.chainConfig.pointValue}¢/pt): -$${fmtDollars(effCalc.pointsValue)}\n`;
                tooltip += `  Effective cost: $${fmtDollars(effCalc.effectiveCost)}\n\n`;

                if (bestRateInfo.pointsCost !== null && data.points) {
                    tooltip += `Points redemption:\n`;
                    tooltip += `  Points to redeem: ${fmtPoints(data.points)}\n`;
                    tooltip += `  Point value (${activeAdapter.chainConfig.pointValue}¢/pt): $${fmtDollars(bestRateInfo.pointsCost)}\n`;
                }

                bestRow.title = tooltip;
                wrapper.appendChild(bestRow);
            }

            container.parentNode.insertBefore(wrapper, container.nextSibling);
            log('Injected display for:', hotelCode);
        } catch (e) {
            log('Error injecting display for', hotelCode, ':', e.message);
        }
    }

    // ============================================
    // IATA CODE INJECTION
    // ============================================
    function fillIataInput() {
        if (!GLOBAL_CONFIG.iataCode || !activeAdapter) return;

        const selector = activeAdapter.selectors.iataInput;
        if (!selector) return;

        const iataInput = document.querySelector(selector);
        if (iataInput && iataInput.value !== GLOBAL_CONFIG.iataCode) {
            iataInput.value = GLOBAL_CONFIG.iataCode;
            iataInput.dispatchEvent(new Event('input', { bubbles: true }));
            iataInput.dispatchEvent(new Event('change', { bubbles: true }));
            log('Filled IATA input with:', GLOBAL_CONFIG.iataCode);
        }
    }

    function setupIataObserver() {
        if (!GLOBAL_CONFIG.iataCode || !activeAdapter?.selectors.iataInput) return;

        const observer = new MutationObserver(() => fillIataInput());
        observer.observe(document.body, { childList: true, subtree: true });
        fillIataInput();
    }

    // ============================================
    // DEBOUNCE
    // ============================================
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    const debouncedProcess = debounce(processHotelCards, 300);

    // ============================================
    // INITIALIZATION
    // ============================================
    // Early init - runs at document-start before page scripts
    function initEarly() {
        if (!activeAdapter) {
            log('No adapter found for this site');
            return;
        }

        log(`StayValue v2.2.0 early init for ${activeAdapter.name}...`);

        // Set up network interception ASAP to catch early requests
        loadFromStorage();
        setupNetworkInterception();

        // Wait for DOM to be ready for everything else
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initDOM);
        } else {
            initDOM();
        }
    }

    // DOM init - runs when DOM is ready
    function initDOM() {
        log('Point valuation:', activeAdapter.chainConfig.pointValue, 'cpp');
        log('Cashback rate:', (activeAdapter.chainConfig.cashbackRate * 100) + '%');
        log('TA rebate rate:', (activeAdapter.chainConfig.travelAgentRebateRate * 100) + '%');
        log('IATA code:', GLOBAL_CONFIG.iataCode || 'not set');
        log('Default elite status:', activeAdapter.defaultEliteStatus);

        setupMenuCommands();
        injectStyles();
        fetchExchangeRates();
        setupIataObserver();

        setTimeout(processHotelCards, 1500);

        // DOM observer for hotel cards
        const observer = new MutationObserver((mutations) => {
            if (!activeAdapter.selectors.hotelCard) return;

            const hasRelevantChanges = mutations.some(mutation => {
                return Array.from(mutation.addedNodes).some(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return false;
                    if (node.classList?.contains('stayvalue-display') || node.classList?.contains('stayvalue-info')) return false;
                    if (node.matches?.(activeAdapter.selectors.hotelCard)) return true;
                    if (node.querySelector?.(activeAdapter.selectors.hotelCard)) return true;
                    return false;
                });
            });

            if (hasRelevantChanges) {
                log('Relevant DOM changes detected');
                debouncedProcess();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // URL observer
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('URL changed to:', lastUrl);
                document.querySelectorAll('[data-stayvalue-processed]').forEach(el => el.removeAttribute('data-stayvalue-processed'));
                document.querySelectorAll('.stayvalue-display').forEach(el => el.remove());
                setTimeout(processHotelCards, 1500);
            }
        });
        urlObserver.observe(document, { subtree: true, childList: true });

        log('StayValue initialized for', activeAdapter.name);
        showInfo(`StayValue active (${activeAdapter.name})`);
    }

    // Start early init immediately
    initEarly();
})();
