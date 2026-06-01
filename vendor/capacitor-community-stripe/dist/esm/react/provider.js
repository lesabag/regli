var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import { Capacitor } from '@capacitor/core';
import React, { createContext, useContext, useEffect, useState } from "react";
import { defineCustomElements } from 'stripe-pwa-elements/loader';
import { Stripe } from '../index';
const StripeContext = createContext({
    stripe: undefined,
    isApplePayAvailable: false,
    isGooglePayAvailable: false,
});
export const useCapacitorStripe = () => {
    return useContext(StripeContext);
};
export const CapacitorStripeProvider = (_a) => {
    var { fallback, children } = _a, initializeOptions = __rest(_a, ["fallback", "children"]);
    const [stripe, setStripe] = useState();
    const [isApplePayAvailable, setApplePayAvailableStatus] = useState(false);
    const [isGooglePayAvailable, setGooglePayAvailableStatus] = useState(false);
    useEffect(() => {
        if (!Capacitor.isNativePlatform()) {
            defineCustomElements();
        }
        if (!initializeOptions.publishableKey) {
            throw new Error('publishableKey must be needed');
        }
        Stripe.initialize(initializeOptions)
            .then(() => {
            return Stripe.isApplePayAvailable().then(() => {
                setApplePayAvailableStatus(true);
            }).catch(() => {
                setApplePayAvailableStatus(false);
            });
        })
            .then(() => {
            return Stripe.isGooglePayAvailable().then(() => {
                setGooglePayAvailableStatus(true);
            }).catch(() => {
                setGooglePayAvailableStatus(false);
            });
        })
            .then(() => {
            setStripe(Stripe);
        });
    }, [initializeOptions, setApplePayAvailableStatus]);
    if (!stripe) {
        if (fallback) {
            return React.createElement(React.Fragment, null, fallback);
        }
        return null;
    }
    return (React.createElement(StripeContext.Provider, { value: {
            stripe,
            isGooglePayAvailable,
            isApplePayAvailable,
        } }, children));
};
//# sourceMappingURL=provider.js.map