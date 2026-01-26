# CLAUDE.md - StayValue Project Guide

## Project Overview

StayValue is a Tampermonkey userscript that helps travelers compare hotel point redemption rates vs cash rates across major hotel loyalty programs (IHG, Marriott, Hyatt, Hilton). It calculates cents-per-point (CPP) values and highlights better-value redemption options.

**Version**: 2.7.0
**Type**: Browser userscript (single-file)

## Quick Reference

### File Structure
```
stayvalue.user.js    # Main userscript (all code in one file)
```

### Supported Hotel Chains
- IHG One Rewards (ihg.com)
- Marriott Bonvoy (marriott.com)
- World of Hyatt (hyatt.com)
- Hilton Honors (hilton.com)

## Development

### No Build Step Required
This is a Tampermonkey userscript - runs directly in the browser with no compilation needed.

### Testing
1. Install Tampermonkey browser extension
2. Add/update the userscript
3. Visit a supported hotel booking page
4. Check browser console for debug logs (debug mode enabled by default)

### Debug Mode
Debug logging is enabled by default (`CONFIG.debug = true`). View logs in browser DevTools console.

## Code Architecture

### Adapter Pattern
Each hotel chain has its own adapter extending BaseAdapter:
- `IHGAdapter` (lines 59-226)
- `MarriottAdapter` (lines 228-367)
- `HyattAdapter` (lines 369-626)
- `HiltonAdapter` (lines 628-757)

Each adapter implements:
- `name`, `match`: Chain identifier and URL pattern
- `brandBasePoints`, `eliteBonusRates`: Points earning configuration
- `selectors`: CSS selectors for DOM elements
- `apiPatterns`: URL patterns for API detection
- `parseAvailabilityResponse()`: Parse hotel search API data
- `parseProfileResponse()`: Extract user elite status

### Key Code Sections
- **Lines 23-53**: Configuration defaults
- **Lines 793-863**: Tampermonkey menu commands (user settings)
- **Lines 869-941**: SessionStorage caching (profile, rates, hotels)
- **Lines 947-1078**: Network interception (fetch/XHR monkey-patching)
- **Lines 1198-1423**: Utility functions (formatting, calculations, exchange rates)
- **Lines 1483-1732**: Main processing (processHotelCards, injectDisplay)
- **Lines 1735-1864**: Initialization (initEarly, initDOM)

### Two-Phase Initialization
1. `initEarly()` @ document-start: Sets up network interception
2. `initDOM()` @ DOMContentLoaded: Sets up UI, menus, DOM observers

### Data Flow
```
API responses intercepted → Adapter parses data → Cached in sessionStorage
→ processHotelCards() reads cache → Calculates CPP/effective costs
→ Injects display into hotel cards
```

## Key Calculations

- **Cash Effective Cost**: Gross rate - cashback - travel agent rebates
- **Points Effective Cost**: Points × user's point valuation
- **CPP**: Net cash cost / (points to redeem + points earned from cashback)
- **Best Rate**: Lower of cash vs points effective cost

## Configuration Storage

Uses Tampermonkey's GM_getValue/GM_setValue:
- `{chain}_pointValue`: User's point valuation (cents)
- `{chain}_cashbackRate`: Cashback percentage
- `{chain}_travelAgentRebateRate`: Travel agent rebate percentage
- `dollarDecimals`: Display precision (0, 1, or 2)
- `iataCode`: Travel agent IATA code

## Conventions

- **Naming**: camelCase for variables/functions, UPPER_CASE for constants
- **Section Headers**: `// ============...` style comments
- **Error Handling**: Try-catch around storage and parsing
- **Logging**: Use `log()` function (respects debug flag)

## Common Tasks

### Adding a New Hotel Chain
1. Create new adapter object extending BaseAdapter pattern
2. Define `name`, `match`, `brandBasePoints`, `eliteBonusRates`
3. Implement `selectors`, `apiPatterns`, parsing methods
4. Add to adapter detection in `getAdapter()` function (line 763)
5. Add `@match` rule in userscript header

### Modifying Calculations
- CPP calculation: `calculateCPP()` function
- Effective costs: `calculatePointsEffectiveCost()`, `calculateCashEffectiveCost()`
- Rate comparison: `determineBestRate()`

### Adding User Settings
1. Add default to CONFIG object (line 23)
2. Add GM_registerMenuCommand in menu section (line 793)
3. Add storage key pattern to match existing conventions
