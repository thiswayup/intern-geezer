define([
	'dojo/_base/declare',
	'dojo/_base/array',
	'dojo/_base/lang',
	'dojo/Stateful',
	'dojo/Deferred',
	'dojo/when',
	'dojo/topic',
	'./util'
], function (declare, array, lang, Stateful, Deferred, when, topic, util) {
	return declare(Stateful, {
		name: '',
		tests: [],
		parent: null,
		setup: null,
		beforeEach: null,
		afterEach: null,
		teardown: null,
		error: null,
		timeElapsed: null,
		_grep: null,
		_remote: null,

		constructor: function () {
			this.tests = [];
		},

		postscript: function () {
			this.inherited(arguments);
			topic.publish('/suite/new', this);
		},

		/**
		 * If true, the suite will only publish its start topic after the setup callback has finished,
		 * and will publish its end topic before the teardown callback has finished.
		 */
		publishAfterSetup: false,

		/**
		 * The unique identifier of the suite, assuming all combinations of suite + test are unique.
		 */
		_idGetter: function () {
			return this.parent ? this.parent.get('id') + ' - ' + this.name : this.name;
		},

		/**
		 * The WebDriver interface for driving a remote environment. This value is only guaranteed to exist from the
		 * setup/beforeEach/afterEach/teardown and test methods, since environments are not instantiated until they are
		 * actually ready to be tested against.
		 */
		_remoteGetter: function () {
			return this.parent ? this.parent.get('remote') : this._remote;
		},

		_remoteSetter: function (value) {
			if (this._remote) {
				throw new Error('remote may only be set once per suite');
			}

			this._remote = value;
		},

		/**
		 * A regular expression used to filter, by test ID, which tests are run.
		 */
		_grepGetter: function () {
			return this._grep || (this.parent && this.parent.get('grep')) || /.*/;
		},

		_grepSetter: function (value) {
			this._grep = value;
		},

		/**
		 * The sessionId of the environment in which the suite executed.
		 */
		_sessionIdGetter: function () {
			var remote;

			return this.parent ? this.parent.get('sessionId') :
				this._sessionId ? this._sessionId :
				(remote = this.get('remote')) ? remote.sessionId :
				null;
		},

		/**
		 * The sessionId may need to be overridden for suites proxied from client.js.
		 */
		_sessionIdSetter: function (value) {
			this._sessionId = value;
		},

		/**
		 * The total number of tests in this suite and any sub-suites. To get only the number of tests for this suite,
		 * look at `this.tests.length`.
		 */
		_numTestsGetter: function () {
			function reduce(numTests, test) {
				return test.tests ? util.reduce(test.tests, reduce, numTests) : numTests + 1;
			}

			return util.reduce(this.tests, reduce, 0);
		},

		/**
		 * The total number of tests in this test suite and any sub-suites that have failed.
		 */
		_numFailedTestsGetter: function () {
			function reduce(numFailedTests, test) {
				return test.tests ?
					util.reduce(test.tests, reduce, numFailedTests) :
					(test.hasPassed || test.skipped != null ? numFailedTests : numFailedTests + 1);
			}

			return util.reduce(this.tests, reduce, 0);
		},

		/**
		 * The total number of tests in this test suite and any sub-suites that were skipped.
		 */
		_numSkippedTestsGetter: function () {
			function reduce(numSkippedTests, test) {
				return test.tests ?
					util.reduce(test.tests, reduce, numSkippedTests) :
					(test.skipped != null ? numSkippedTests + 1 : numSkippedTests);
			}

			return util.reduce(this.tests, reduce, 0);
		},

		/**
		 * Runs test suite in order:
		 *
		 * * setup
		 * * for each test:
		 *   * beforeEach
		 *   * test
		 *   * afterEach
		 * * teardown
		 *
		 * If setup, beforeEach, afterEach, or teardown throw, the suite itself will be marked as failed
		 * and no further tests in the suite will be executed.
		 *
		 * @returns {dojo/promise/Promise}
		 */
		run: function () {
			/**
			 * Convenience mechanism for calling pre/post test methods which captures and handles errors that might be
			 * raised by these methods.
			 */
			function call(name) {
				function callOnSuite(suite) {
					var result;
					try {
						result = suite[name] && suite[name]();
					}
					catch (error) {
						var dfd = new Deferred();
						dfd.reject(error);
						result = dfd.promise;
					}

					return when(result);
				}

				if (name == null) {
					return when(undefined);
				}
				// all parent suites' beforeEach/afterEach methods also need to be executed when a test is executed
				// to meet user expectations; see https://github.com/theintern/intern/issues/67
				else if (name === 'beforeEach' || name === 'afterEach') {
					// beforeEach executes in order parent -> child;
					// afterEach executes in order child -> parent
					var orderMethod = name === 'beforeEach' ? 'push' : 'unshift',
						// LIFO queue
						suitesQueue = [],
						suite = self;

					do {
						suitesQueue[orderMethod](suite);
					}
					while ((suite = suite.parent));

					var dfd = new Deferred(),
						queueError;

					(function runNextSuite() {
						if (suitesQueue.length) {
							callOnSuite(suitesQueue.pop())
								// in order to ensure that parent suites still have the opportunity to clean up,
								// all afterEach methods are executed, even if an earlier afterEach threw an error
								.then(runNextSuite, name === 'afterEach' ? function (error) {
									queueError = error;
									topic.publish('/error', error);
									runNextSuite();
								} : lang.hitch(dfd, 'reject'));
						}
						else {
							queueError ? dfd.reject(queueError) : dfd.resolve();
						}
					})();

					return dfd.promise;
				}
				else {
					return callOnSuite(self);
				}
			}

			function runNextTest() {
				// TODO: Eliminate nextTick once dojo/promise implements Promises/A+
				function nextTick(fn) {
					/*global process:false, setImmediate:false */
					if (typeof process !== 'undefined' && process.nextTick) {
						process.nextTick(fn);
					}
					else if (typeof setImmediate !== 'undefined') {
						setImmediate(fn);
					}
					else {
						setTimeout(fn, 0);
					}
				}

				nextTick(function () {
					function handleTestError(error) {
						error.relatedTest = test;
						handleFatalError.apply(this, arguments);
					}

					function runTest(test) {
						// if a test is actually a nested suite, beforeEach/afterEach should not be invoked; passing
						// null as the call name is the cleanest way to do a no-op in this scenario
						call(test.tests ? null : 'beforeEach').then(function () {
							test.run().always(function () {
								// TODO: Does remote need to be reset somehow?
								call(test.tests ? null : 'afterEach').then(runNextTest, handleTestError);
							});
						}, handleTestError);
					}

					var test = tests[i++];
					if (test) {
						if (!test.tests && !self.get('grep').test(test.get('id'))) {
							test.skipped = 'grep';
						}
						runTest(test);
					}
					else {
						finishRun();
					}
				});
			}

			function handleFatalError(error, fromFinishRun) {
				self.error = error;
				topic.publish('/suite/error', self);
				topic.publish('/error', error);

				if (!fromFinishRun) {
					finishRun(error);
				}
			}

			function finishRun(error) {
				if (started) {
					if (self.publishAfterSetup) {
						self.timeElapsed = new Date().getTime() - startTime;
						topic.publish('/suite/end', self);
					}

					call('teardown').always(function (teardownError) {
						if (!error && teardownError instanceof Error) {
							handleFatalError(teardownError, true);
							error = teardownError;
						}

						if (!self.publishAfterSetup) {
							self.timeElapsed = new Date().getTime() - startTime;
							topic.publish('/suite/end', self);
						}

						error ? dfd.reject(error) : dfd.resolve();
					});
				}
				else {
					dfd.reject(error);
				}
			}

			var startTime;
			var started = false;
			var dfd = new Deferred();
			var self = this;
			var tests = this.tests;
			var i = 0;

			if (!self.publishAfterSetup) {
				topic.publish('/suite/start', self);
				started = true;
				startTime = new Date().getTime();
			}

			call('setup').then(function () {
				if (self.publishAfterSetup) {
					started = true;
					topic.publish('/suite/start', self);
					startTime = new Date().getTime();
				}
			}).then(runNextTest, handleFatalError);

			return dfd.promise;
		},

		toJSON: function () {
			return {
				name: this.name,
				sessionId: this.get('sessionId'),
				hasParent: !!this.parent,
				tests: array.map(this.tests, function (test) { return test.toJSON(); }),
				timeElapsed: this.timeElapsed,
				numTests: this.get('numTests'),
				numFailedTests: this.get('numFailedTests'),
				numSkippedTests: this.get('numSkippedTests'),
				error: this.error ? {
					name: this.error.name,
					message: this.error.message,
					stack: this.error.stack,
					relatedTest: this.error.relatedTest
				} : null
			};
		}
	});
});
