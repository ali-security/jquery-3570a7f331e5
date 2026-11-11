/*
 * Headless runner for the QUnit suite in test/index.html (CI tooling, not
 * part of the published package — /test is in .npmignore).
 *
 * Usage: node test/run-qunit.js <url> [timeoutSeconds]
 *
 * Opens the suite in headless Chrome (puppeteer-core, CHROME_BIN), prints one
 * line per test (ok / not ok, module, name, assertion counts), every failed
 * assertion, and a summary line; exits non-zero when any test fails or the
 * suite does not finish before the timeout.
 */
"use strict";

const puppeteer = require( "puppeteer-core" );

const url = process.argv[ 2 ];
const timeoutSeconds = parseInt( process.argv[ 3 ] || "1500", 10 );

( async function() {
	const browser = await puppeteer.launch( {
		executablePath: process.env.CHROME_BIN,
		headless: true,
		args: [ "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage" ]
	} );
	const page = await browser.newPage();
	await page.setViewport( { width: 1280, height: 1024 } );

	let testsPassed = 0, testsFailed = 0;
	let failures = [];
	const skipped = [];

	let resolveDone;
	const done = new Promise( function( resolve ) {
		resolveDone = resolve;
	} );

	function onLog( d ) {
		if ( !d.result ) {
			failures.push( "    assertion failed: " + ( d.message || "" ) +
				( d.expected !== undefined ? " (expected: " + d.expected + ", actual: " + d.actual + ")" : "" ) +
				( d.source ? "\n      " + String( d.source ).split( "\n" )[ 0 ] : "" ) );
		}
	}
	function onTestDone( d ) {
		const label = d.module + ": " + d.name + " (" + d.passed + "/" + d.total + " assertions)";
		if ( d.failed > 0 ) {
			testsFailed++;
			console.log( "not ok - " + label );
			failures.forEach( function( f ) {
				console.log( f );
			} );
		} else {
			testsPassed++;
			console.log( "ok - " + label );
		}
		failures = [];
	}

	// Events travel over the page console (not page.exposeFunction): some tests
	// replace window.JSON, which breaks puppeteer's binding serialization.
	page.on( "console", function( msg ) {
		const text = msg.text();
		if ( text.indexOf( "__QUNIT__" ) === 0 ) {
			const ev = JSON.parse( text.slice( "__QUNIT__".length ) );
			if ( ev.type === "log" ) {
				onLog( ev.data );
			} else if ( ev.type === "testDone" ) {
				onTestDone( ev.data );
			} else if ( ev.type === "done" ) {
				resolveDone( ev.data );
			}
		} else if ( text.indexOf( "SKIPPED:" ) === 0 ) {
			skipped.push( text );
			console.log( text );
		}
	} );

	// Register the QUnit callbacks in the top frame as soon as QUnit is defined
	// (it is loaded synchronously in <head>; tests start on window load).
	// JSON.stringify / console.log are captured before any page script runs.
	await page.evaluateOnNewDocument( function() {
		if ( window !== window.top ) {
			return;
		}
		var stringify = JSON.stringify,
			log = console.log.bind( console ),
			emit = function( type, data ) {
				log( "__QUNIT__" + stringify( { type: type, data: data } ) );
			},
			timer = setInterval( function() {
				if ( window.QUnit && window.QUnit.testDone ) {
					clearInterval( timer );
					QUnit.log( function( d ) {
						emit( "log", {
							result: d.result, message: d.message, source: d.source,
							expected: d.expected === undefined ? undefined : String( d.expected ),
							actual: d.actual === undefined ? undefined : String( d.actual )
						} );
					} );
					QUnit.testDone( function( d ) {
						emit( "testDone", { module: d.module, name: d.name,
							passed: d.passed, failed: d.failed, total: d.total } );
					} );
					QUnit.done( function( d ) {
						emit( "done", { passed: d.passed, failed: d.failed,
							total: d.total, runtime: d.runtime } );
					} );
				}
			}, 0 );
	} );

	page.on( "pageerror", function( err ) {
		console.log( "page error: " + err.message );
	} );

	console.log( "Running QUnit suite: " + url );
	await page.goto( url, { waitUntil: "domcontentloaded", timeout: 120000 } );

	const timeout = new Promise( function( resolve ) {
		setTimeout( function() {
			resolve( null );
		}, timeoutSeconds * 1000 );
	} );
	const result = await Promise.race( [ done, timeout ] );
	await browser.close();

	if ( !result ) {
		console.log( "QUnit suite did not finish within " + timeoutSeconds + "s" );
		console.log( "Tests: " + testsPassed + " passed, " + testsFailed + " failed (incomplete)" );
		skipped.forEach( function( line ) {
			console.log( "  " + line );
		} );
		process.exit( 2 );
	}

	console.log( "" );
	console.log( "Tests: " + testsPassed + " passed, " + testsFailed + " failed, " +
		( testsPassed + testsFailed ) + " total, " + skipped.length + " skipped" );
	skipped.forEach( function( line ) {
		console.log( "  " + line );
	} );
	console.log( "Assertions: " + result.passed + " passed, " + result.failed + " failed, " +
		result.total + " total (" + result.runtime + " ms)" );
	process.exit( testsFailed > 0 || result.failed > 0 ? 1 : 0 );
} )().catch( function( err ) {
	console.error( err );
	process.exit( 3 );
} );
