var capacitorStripe = (function (exports, core) {
    'use strict';

    exports.ApplePayEventsEnum = void 0;
    (function (ApplePayEventsEnum) {
        ApplePayEventsEnum["Loaded"] = "applePayLoaded";
        ApplePayEventsEnum["FailedToLoad"] = "applePayFailedToLoad";
        ApplePayEventsEnum["Completed"] = "applePayCompleted";
        ApplePayEventsEnum["Canceled"] = "applePayCanceled";
        ApplePayEventsEnum["Failed"] = "applePayFailed";
        ApplePayEventsEnum["DidSelectShippingContact"] = "applePayDidSelectShippingContact";
        ApplePayEventsEnum["DidCreatePaymentMethod"] = "applePayDidCreatePaymentMethod";
    })(exports.ApplePayEventsEnum || (exports.ApplePayEventsEnum = {}));

    exports.GooglePayEventsEnum = void 0;
    (function (GooglePayEventsEnum) {
        GooglePayEventsEnum["Loaded"] = "googlePayLoaded";
        GooglePayEventsEnum["FailedToLoad"] = "googlePayFailedToLoad";
        GooglePayEventsEnum["Completed"] = "googlePayCompleted";
        GooglePayEventsEnum["Canceled"] = "googlePayCanceled";
        GooglePayEventsEnum["Failed"] = "googlePayFailed";
    })(exports.GooglePayEventsEnum || (exports.GooglePayEventsEnum = {}));

    exports.PaymentFlowEventsEnum = void 0;
    (function (PaymentFlowEventsEnum) {
        PaymentFlowEventsEnum["Loaded"] = "paymentFlowLoaded";
        PaymentFlowEventsEnum["FailedToLoad"] = "paymentFlowFailedToLoad";
        PaymentFlowEventsEnum["Opened"] = "paymentFlowOpened";
        PaymentFlowEventsEnum["Created"] = "paymentFlowCreated";
        PaymentFlowEventsEnum["Completed"] = "paymentFlowCompleted";
        PaymentFlowEventsEnum["Canceled"] = "paymentFlowCanceled";
        PaymentFlowEventsEnum["Failed"] = "paymentFlowFailed";
    })(exports.PaymentFlowEventsEnum || (exports.PaymentFlowEventsEnum = {}));

    exports.PaymentSheetEventsEnum = void 0;
    (function (PaymentSheetEventsEnum) {
        PaymentSheetEventsEnum["Loaded"] = "paymentSheetLoaded";
        PaymentSheetEventsEnum["FailedToLoad"] = "paymentSheetFailedToLoad";
        PaymentSheetEventsEnum["Completed"] = "paymentSheetCompleted";
        PaymentSheetEventsEnum["Canceled"] = "paymentSheetCanceled";
        PaymentSheetEventsEnum["Failed"] = "paymentSheetFailed";
    })(exports.PaymentSheetEventsEnum || (exports.PaymentSheetEventsEnum = {}));

    const Stripe = core.registerPlugin('Stripe', {
        web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.StripeWeb()),
    });

    /**
     * @url https://github.com/ionic-team/ionic-framework/blob/main/core/src/utils/platform.ts
     * So `@typescript-eslint/no-explicit-any` `@typescript-eslint/no-non-null-assertion` is disabled here
     */
    const getPlatforms = (win) => setupPlatforms(win);
    const isPlatform = (winOrPlatform, platform) => {
        if (typeof winOrPlatform === 'string') {
            platform = winOrPlatform;
            winOrPlatform = undefined;
        }
        return getPlatforms(winOrPlatform).includes(platform);
    };
    const setupPlatforms = (win = window) => {
        if (typeof win === 'undefined') {
            return [];
        }
        win.Ionic = win.Ionic || {};
        let platforms = win.Ionic.platforms;
        if (platforms == null) {
            platforms = win.Ionic.platforms = detectPlatforms(win);
            platforms.forEach(p => win.document.documentElement.classList.add(`plt-${p}`));
        }
        return platforms;
    };
    const detectPlatforms = (win) => Object.keys(PLATFORMS_MAP).filter(p => PLATFORMS_MAP[p](win));
    const isMobileWeb = (win) => isMobile(win) && !isHybrid(win);
    const isIpad = (win) => {
        // iOS 12 and below
        if (testUserAgent(win, /iPad/i)) {
            return true;
        }
        // iOS 13+
        if (testUserAgent(win, /Macintosh/i) && isMobile(win)) {
            return true;
        }
        return false;
    };
    const isIphone = (win) => testUserAgent(win, /iPhone/i);
    const isIOS = (win) => testUserAgent(win, /iPhone|iPod/i) || isIpad(win);
    const isAndroid = (win) => testUserAgent(win, /android|sink/i);
    const isAndroidTablet = (win) => {
        return isAndroid(win) && !testUserAgent(win, /mobile/i);
    };
    const isPhablet = (win) => {
        const width = win.innerWidth;
        const height = win.innerHeight;
        const smallest = Math.min(width, height);
        const largest = Math.max(width, height);
        return (smallest > 390 && smallest < 520) &&
            (largest > 620 && largest < 800);
    };
    const isTablet = (win) => {
        const width = win.innerWidth;
        const height = win.innerHeight;
        const smallest = Math.min(width, height);
        const largest = Math.max(width, height);
        return (isIpad(win) ||
            isAndroidTablet(win) ||
            ((smallest > 460 && smallest < 820) &&
                (largest > 780 && largest < 1400)));
    };
    const isMobile = (win) => matchMedia(win, '(any-pointer:coarse)');
    const isDesktop = (win) => !isMobile(win);
    const isHybrid = (win) => isCordova(win) || isCapacitorNative(win);
    const isCordova = (win) => !!(win['cordova'] || win['phonegap'] || win['PhoneGap']);
    const isCapacitorNative = (win) => {
        const capacitor = win['Capacitor'];
        return !!(capacitor === null || capacitor === void 0 ? void 0 : capacitor.isNative);
    };
    const isElectron = (win) => testUserAgent(win, /electron/i);
    const isPWA = (win) => !!(win.matchMedia('(display-mode: standalone)').matches || win.navigator.standalone);
    const testUserAgent = (win, expr) => expr.test(win.navigator.userAgent);
    const matchMedia = (win, query) => win.matchMedia(query).matches;
    const PLATFORMS_MAP = {
        'ipad': isIpad,
        'iphone': isIphone,
        'ios': isIOS,
        'android': isAndroid,
        'phablet': isPhablet,
        'tablet': isTablet,
        'cordova': isCordova,
        'capacitor': isCapacitorNative,
        'electron': isElectron,
        'pwa': isPWA,
        'mobile': isMobile,
        'mobileweb': isMobileWeb,
        'desktop': isDesktop,
        'hybrid': isHybrid
    };

    class StripeWeb extends core.WebPlugin {
        async initialize(options) {
            if (typeof options.publishableKey !== 'string' || options.publishableKey.trim().length === 0) {
                throw new Error('you must provide a valid key');
            }
            this.publishableKey = options.publishableKey;
            if (options.stripeAccount) {
                this.stripeAccount = options.stripeAccount;
            }
        }
        async createPaymentSheet(options) {
            var _a;
            if (!this.publishableKey) {
                this.notifyListeners(exports.PaymentSheetEventsEnum.FailedToLoad, null);
                return;
            }
            this.cardElementModal = document.createElement('stripe-card-element-modal');
            (_a = document.querySelector('body')) === null || _a === void 0 ? void 0 : _a.appendChild(this.cardElementModal);
            await customElements.whenDefined('stripe-card-element-modal');
            this.cardElementModal.publishableKey = this.publishableKey;
            if (this.stripeAccount) {
                this.cardElementModal.stripeAccount = this.stripeAccount;
            }
            this.cardElementModal.applicationName = '@capacitor-community/stripe';
            this.cardElementModal.intentClientSecret = options.paymentIntentClientSecret;
            this.cardElementModal.intentType = 'payment';
            if (options.withZipCode !== undefined) {
                this.cardElementModal.zip = options.withZipCode;
            }
            this.notifyListeners(exports.PaymentSheetEventsEnum.Loaded, null);
        }
        async presentPaymentSheet() {
            if (!this.cardElementModal) {
                throw new Error();
            }
            const props = await this.cardElementModal.present();
            if (props === undefined) {
                this.notifyListeners(exports.PaymentSheetEventsEnum.Canceled, null);
                return {
                    paymentResult: exports.PaymentSheetEventsEnum.Canceled,
                };
            }
            const { detail: { stripe, cardNumberElement }, } = props;
            const result = await stripe.createPaymentMethod({
                type: 'card',
                card: cardNumberElement,
            });
            this.cardElementModal.updateProgress('success');
            this.cardElementModal.remove();
            if (result.error !== undefined) {
                this.notifyListeners(exports.PaymentSheetEventsEnum.Failed, null);
                return {
                    paymentResult: exports.PaymentSheetEventsEnum.Failed,
                };
            }
            this.notifyListeners(exports.PaymentSheetEventsEnum.Completed, null);
            return {
                paymentResult: exports.PaymentSheetEventsEnum.Completed,
            };
        }
        async createPaymentFlow(options) {
            var _a;
            if (!this.publishableKey) {
                this.notifyListeners(exports.PaymentFlowEventsEnum.FailedToLoad, null);
                return;
            }
            this.cardElementModal = document.createElement('stripe-card-element-modal');
            (_a = document.querySelector('body')) === null || _a === void 0 ? void 0 : _a.appendChild(this.cardElementModal);
            await customElements.whenDefined('stripe-card-element-modal');
            this.cardElementModal.publishableKey = this.publishableKey;
            if (this.stripeAccount) {
                this.cardElementModal.stripeAccount = this.stripeAccount;
            }
            this.cardElementModal.applicationName = '@capacitor-community/stripe';
            // eslint-disable-next-line no-prototype-builtins
            if (options.hasOwnProperty('paymentIntentClientSecret')) {
                this.cardElementModal.intentType = 'payment';
                this.cardElementModal.intentClientSecret = options.paymentIntentClientSecret;
            }
            else {
                this.cardElementModal.intentType = 'setup';
                this.cardElementModal.intentClientSecret = options.setupIntentClientSecret;
            }
            if (options.withZipCode !== undefined) {
                this.cardElementModal.zip = options.withZipCode;
            }
            if (isPlatform(window, 'ios')) {
                this.cardElementModal.buttonLabel = 'Add card';
                this.cardElementModal.sheetTitle = 'Add a card';
            }
            else {
                this.cardElementModal.buttonLabel = 'Add';
            }
            this.notifyListeners(exports.PaymentFlowEventsEnum.Loaded, null);
        }
        async presentPaymentFlow() {
            if (!this.cardElementModal) {
                throw new Error();
            }
            this.notifyListeners(exports.PaymentFlowEventsEnum.Opened, null);
            const props = await this.cardElementModal.present().catch(() => undefined);
            if (props === undefined) {
                this.notifyListeners(exports.PaymentFlowEventsEnum.Canceled, null);
                throw new Error();
            }
            const { detail: { stripe, cardNumberElement }, } = props;
            const { token } = await stripe.createToken(cardNumberElement);
            if (token === undefined || token.card === undefined) {
                throw new Error();
            }
            this.flowStripe = stripe;
            this.flowCardNumberElement = cardNumberElement;
            this.notifyListeners(exports.PaymentFlowEventsEnum.Created, {
                cardNumber: token.card.last4,
            });
            return {
                cardNumber: token.card.last4,
            };
        }
        async confirmPaymentFlow() {
            if (!this.cardElementModal || !this.flowStripe || !this.flowCardNumberElement) {
                throw new Error();
            }
            const result = await this.flowStripe.createPaymentMethod({
                type: 'card',
                card: this.flowCardNumberElement,
            });
            if (result.error !== undefined) {
                this.notifyListeners(exports.PaymentFlowEventsEnum.Failed, null);
            }
            this.cardElementModal.updateProgress('success');
            this.cardElementModal.remove();
            this.notifyListeners(exports.PaymentFlowEventsEnum.Completed, null);
            return {
                paymentResult: exports.PaymentFlowEventsEnum.Completed,
            };
        }
        isApplePayAvailable() {
            return this.isAvailable('applePay');
        }
        async createApplePay(createApplePayOption) {
            if (!this.publishableKey) {
                this.notifyListeners(exports.ApplePayEventsEnum.FailedToLoad, null);
                return;
            }
            this.requestApplePay = await this.createPaymentRequestButton();
            this.requestApplePayOptions = createApplePayOption;
            this.notifyListeners(exports.ApplePayEventsEnum.Loaded, null);
        }
        presentApplePay() {
            return this.presentPaymentRequestButton('applePay', this.requestApplePay, this.requestApplePayOptions, exports.ApplePayEventsEnum);
        }
        isGooglePayAvailable() {
            return this.isAvailable('googlePay');
        }
        async createGooglePay(createGooglePayOption) {
            if (!this.publishableKey) {
                this.notifyListeners(exports.GooglePayEventsEnum.FailedToLoad, null);
                return;
            }
            this.requestGooglePay = await this.createPaymentRequestButton();
            this.requestGooglePayOptions = createGooglePayOption;
            this.notifyListeners(exports.GooglePayEventsEnum.Loaded, null);
        }
        presentGooglePay() {
            return this.presentPaymentRequestButton('googlePay', this.requestGooglePay, this.requestGooglePayOptions, exports.GooglePayEventsEnum);
        }
        async isAvailable(type) {
            var _a;
            const requestButton = document.createElement('stripe-payment-request-button');
            requestButton.id = `isAvailable-${type}`;
            (_a = document.querySelector('body')) === null || _a === void 0 ? void 0 : _a.appendChild(requestButton);
            await customElements.whenDefined('stripe-payment-request-button');
            if (this.publishableKey) {
                requestButton.publishableKey = this.publishableKey;
            }
            if (this.stripeAccount) {
                requestButton.stripeAccount = this.stripeAccount;
            }
            requestButton.applicationName = '@capacitor-community/stripe';
            return await requestButton.isAvailable(type).finally(() => requestButton.remove());
        }
        async createPaymentRequestButton() {
            var _a;
            const requestButton = document.createElement('stripe-payment-request-button');
            (_a = document.querySelector('body')) === null || _a === void 0 ? void 0 : _a.appendChild(requestButton);
            await customElements.whenDefined('stripe-payment-request-button');
            if (this.publishableKey) {
                requestButton.publishableKey = this.publishableKey;
            }
            if (this.stripeAccount) {
                requestButton.stripeAccount = this.stripeAccount;
            }
            requestButton.applicationName = '@capacitor-community/stripe';
            return requestButton;
        }
        async presentPaymentRequestButton(type, requestButton, requestButtonOptions, EventsEnum) {
            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve) => {
                if (requestButton === undefined || requestButtonOptions === undefined || this.publishableKey === undefined) {
                    this.notifyListeners(EventsEnum.Failed, null);
                    return resolve({
                        paymentResult: EventsEnum.Failed,
                    });
                }
                await requestButton.setPaymentRequestOption({
                    country: requestButtonOptions.countryCode.toUpperCase(),
                    currency: requestButtonOptions.currency.toLowerCase(),
                    total: requestButtonOptions.paymentSummaryItems[requestButtonOptions.paymentSummaryItems.length - 1],
                    disableWallets: type === 'applePay' ? ['googlePay', 'browserCard'] : ['applePay', 'browserCard'],
                    requestPayerName: true,
                    requestPayerEmail: true,
                });
                // await this.requestButton.setPaymentRequestShippingAddressEventHandler(async (event, stripe) => {});
                const intentClientSecret = requestButtonOptions.paymentIntentClientSecret;
                await requestButton.setPaymentMethodEventHandler(async (event, stripe) => {
                    const { paymentIntent, error: confirmError } = await stripe.confirmCardPayment(intentClientSecret, {
                        payment_method: event.paymentMethod.id,
                    }, { handleActions: false });
                    if (confirmError) {
                        event.complete('fail');
                        this.notifyListeners(EventsEnum.Failed, confirmError);
                        return resolve({
                            paymentResult: EventsEnum.Failed,
                        });
                    }
                    if ((paymentIntent === null || paymentIntent === void 0 ? void 0 : paymentIntent.status) === 'requires_action') {
                        const { error: confirmError } = await stripe.confirmCardPayment(intentClientSecret);
                        if (confirmError) {
                            event.complete('fail');
                            this.notifyListeners(EventsEnum.Failed, confirmError);
                            return resolve({
                                paymentResult: EventsEnum.Failed,
                            });
                        }
                    }
                    event.complete('success');
                    this.notifyListeners(EventsEnum.Completed, null);
                    return resolve({
                        paymentResult: EventsEnum.Completed,
                    });
                });
                await requestButton.initStripe(this.publishableKey, {
                    stripeAccount: this.stripeAccount,
                    showButton: false,
                });
            });
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        StripeWeb: StripeWeb
    });

    exports.Stripe = Stripe;

    return exports;

})({}, capacitorExports);
//# sourceMappingURL=plugin.js.map
