var events = require('events');
var async = require('async');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');
// var store = require('store'); (Maybe we can use this in the future)


/*process.on('uncaughtException', function(err) {
    console.log(err.stack);
    throw err;
});*/

var pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    var emitLog = function (text) { _this.emit('log', 'debug', text); };
    var emitWarningLog = function (text) { _this.emit('log', 'warning', text); };
    var emitErrorLog = function (text) { _this.emit('log', 'error', text); };
    var emitSpecialLog = function (text) { _this.emit('log', 'special', text); };



    if (!(options.coin.algorithm in algos)) {
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }



    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };



    function GetFirstJob(finishedCallback) {

        GetBlockTemplate(true, function (error, result) {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            var portWarnings = [];

            var networkDiffAdjusted = options.initStats.difficulty;

            Object.keys(options.ports).forEach(function (port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }

            finishedCallback();

        });
    }


    function OutputPoolInfo() {

        var startMessage = 'Stratum Pool Server Started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + ']';
        if (process.env.forkId && process.env.forkId !== '0') {
            emitLog(startMessage);
            return;
        }
        var infoLines = [startMessage,
                'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
                'Detected Reward Type:\t' + options.coin.reward,
                'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
                'Current Connect Peers:\t' + options.initStats.connections,
                'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier,
                'Network Difficulty:\t' + options.initStats.difficulty,
                'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
                'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
                'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback) {

        var checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', [{ "capabilities": ["coinbasetxn", "workid", "coinbase/append"], "rules": ["segwit"]}], function (results) {
                var synced = results.every(function (r) {
                    return !r.error || r.error.code !== -10;
                });
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);

                    //Only let the first fork show synced status or the log wil look flooded with it
                    if (!process.env.forkId || process.env.forkId === '0')
                        generateProgress();
                }

            });
        };
        checkSynced(function () {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });


        var generateProgress = function () {

            var cmd = options.coin.hasGetInfo ? 'getinfo' : 'getblockchaininfo';
            _this.daemon.cmd(cmd, [], function (results) {
                var blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], function (results) {

                    var peers = results[0].response;
                    var totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    var percent = (blockCount / totalBlocks * 100).toFixed(2);
                    emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                });

            });
        };

    }


    function SetupApi() {
        if (typeof (options.api) !== 'object' || typeof (options.api.start) !== 'function') {
            return;
        } else {
            options.api.start(_this);
        }
    }

    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled)
            return;

        if (options.testnet && !options.coin.peerMagicTestnet) {
            if (false)
                emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic) {
            if (false)
                emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', function () {
            emitLog('p2p connection successful');
        }).on('connectionRejected', function () {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function () {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function (e) {
            emitErrorLog('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function (e) {
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function (msg) {
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function (hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }


    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    /*
    Coin daemons either use submitblock or getblocktemplate for submitting new blocks
    */
    function SubmitBlock(blockHex, callback) {

        var rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{ 'mode': 'submit', 'data': blockHex}];
        }


        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            function (results) {
                for (var i = 0; i < results.length; i++) {
                    var result = results[i];
                    if (result.error) {
                        emitErrorLog('rpc error with daemon instance ' +
                                result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                                JSON.stringify(result.error)
                        );
                        return;
                    }
                    else if (result.response === 'rejected') {
                        emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                        return;
                    }
                }
                emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
                callback();
            }
        );

    }


    function SetupRecipients() {
        var recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};
        for (var r in options.rewardRecipients) {
            var percent = options.rewardRecipients[r];
            var rObj = {
                percent: percent / 100
            };
            try {
                if (r.length === 40)
                    rObj.script = util.miningKeyToScript(r);
                else
                    rObj.script = util.addressToScript(r);
                recipients.push(rObj);
                options.feePercent += percent;
            }
            catch (e) {
                emitErrorLog('Error generating transaction output script for ' + r + ' in rewardRecipients');
            }
        }
        if (recipients.length === 0) {
            emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }

    function SetupJobManager() {

        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                var job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (shareData, blockHex) {

            var isValidShare = !shareData.error;
            var isValidBlock = (shareData.blockSolved == 1);

            var emitShare = function () {

                var dateNow = Date.now();
                var hashrateData1 = isValidShare ? shareData.difficulty : -shareData.difficulty;
                var hashrateData2 = shareData.worker;
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
            If we calculated that the block solution was found,
            before we emit the share, lets submit the block,
            then check if it was accepted using RPC getblock
            */

            if (shareData.blockSolved != 1) {
                isValidBlock = false;
                var fSubmitUnsolvedBlocks = 0;
                if (fSubmitUnsolvedBlocks == 1) {
                    // For now submit every block (even invalids), to see if we solve more or not
                    SubmitBlock(shareData.blockSolveData, function () {
                        CheckBlockAccepted(shareData.x11hash, function (isAccepted, tx) {
                            isValidBlock = isAccepted;
                            shareData.txHash = tx;
                            emitShare();
                            GetBlockTemplate(true, function (error, result, foundNewBlock) {
                                if (foundNewBlock)
                                    emitLog('Block notification after block submission via RPC3');
                            });

                        });
                    });
                }
                else {

                    emitShare();
                    GetBlockTemplate(true, function (error, result, foundNewBlock) {
                        if (foundNewBlock)
                            emitLog('New BBP Block discovered via GBT after share found');

                    });
                    // Cut down chance of stale blocks:
                    _this.emit('broadcastTimeout');
                }

            }
            else {
                if (false) {
                    console.log('Submitting to RPC to check rxhash %s, x11hash %s\n', shareData.blockSolveData, shareData.x11hash);
                }
                SubmitBlock(shareData.blockSolveData, function () {
                    CheckBlockAccepted(shareData.x11hash, function (isAccepted, tx) {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        GetBlockTemplate(true, function (error, result, foundNewBlock) {
                            if (foundNewBlock)
                                emitLog('Block notification after block submission via RPC1');
                        });

                    });
                });
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }


    function SetupDaemonInterface(finishedCallback) {

        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }

        _this.daemon = new daemon.interface(options.daemons, function (severity, message) {
            _this.emit('log', severity, message);
        });

        _this.daemon.once('online', function () {
            finishedCallback();

        }).on('connectionFailed', function (error) {
            emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));

        }).on('error', function (message) {
            emitErrorLog(message);

        });

        _this.daemon.init();
    }


    function DetectCoinData(finishedCallback) {

        var batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];

        if (options.coin.hasGetInfo) {
            batchRpcCalls.push(['getinfo', []]);
        } else {
            batchRpcCalls.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
        }
        _this.daemon.batchCmd(batchRpcCalls, function (error, results) {
            if (error || !results) {
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }

            var rpcResults = {};

            for (var i = 0; i < results.length; i++) {
                var rpcCall = batchRpcCalls[i][0];
                var r = results[i];
                rpcResults[rpcCall] = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid) {
                emitErrorLog('Daemon reports address is not valid');
                return;
            }

            if (!options.coin.reward) {
                if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                    options.coin.reward = 'POS';
                else
                    options.coin.reward = 'POW';
            }


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
            only given if address is owned by wallet.*/
            if (options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) == 'undefined') {
                emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            options.poolAddressScript = (function () {
                switch (options.coin.reward) {
                    case 'POS':
                        return util.pubkeyToScript(rpcResults.validateaddress.pubkey);
                    case 'POW':
                        return util.addressToScript(rpcResults.validateaddress.address);
                }
            })();

            options.testnet = options.coin.hasGetInfo ? rpcResults.getinfo.testnet : (rpcResults.getblockchaininfo.chain === 'test') ? true : false;

            options.protocolVersion = options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;

            var difficulty = options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
            if (typeof (difficulty) == 'object') {
                difficulty = difficulty['proof-of-work'];
            }

            options.initStats = {
                connections: (options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections),
                difficulty: difficulty * algos[options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };


            if (rpcResults.submitblock.message === 'Method not found') {
                options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1) {
                options.hasSubmitMethod = true;
            }
            else {
                emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }

            finishedCallback();

        });
    }

    /*
    function Store(address, float1, float2, float3, float4, float5, float6) {
    if (!store.get(address)) {
    store.set(address, { bbpsuccess: 0, bbpfail: 0, xmrsuccess: 0, xmrfail: 0, xmrcharitysuccess: 0, ail: 0 });
    console.log(" again %s  ", address);
    }

    store.set(address, { bbpsuccess: float1, bbpfail: float2, xmrsuccess: float3, xmrfail: float4, xmrcharitysuccess: float5, ail: float6 });
    var g = store.get(address);
    if (false)
    console.log(" bbp1 %d, xmr1 %d, float6 %d", g.bbpsuccess, g.xmrsuccess, g.ail);
    }
    */

    function StartStratumServer(finishedCallback) {

        _this.stratumServer = new stratum.Server(options, authorizeFn);

        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('broadcastTimeout', function () {
            if (new Date() % 7 == 0)
                emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            GetBlockTemplate(true, function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function (client) {
            if (typeof (_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {

                var extraNonce = _this.jobManager.extraNonceCounter.next();
                var extraNonce2Size = _this.jobManager.extraNonce2Size;
                resultCallback(null,
                    extraNonce,
                    extraNonce2Size
                );

                if (typeof (options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }

                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', function (params, resultCallback) {

                // RANDOMX - BIBLEPAY - mining.onsubmit
                // Since RandomX solves for an equation, we must assemble the RandomX header, RandomX seed-key, bbp_blake_hash and compute RX_hash ourselves.
                var blockSolution = '';
                var rpcBlockHash = '';
                var bufRandomXHeader = new Buffer(params.randomXHeader, 'hex');
                var hashDigest = algos[options.coin.algorithm].hash(options.coin);
                var nTimeInt = parseInt(params.nTime, 16);
                var headerHash = hashDigest(bufRandomXHeader);

                /*
                if (true)
                console.log('\nReceived nTime %d, RxHeader [%s] -- RxKey[%s] -- InRxHash %s  %d %d %d %d %d %d \n',
                nTimeInt, params.randomXHeader, params.randomXKey, params.in_rxhash, params.bbpsuccess, params.bbpfail, params.xmrsuccess, params.xmrfail, params.xmrcharitysuccess, params.ail);

                Store(params.name, params.bbpsuccess, params.bbpfail, params.xmrsuccess, params.xmrfail, params.xmrcharitysuccess, params.ail);
                */

                GetRandomXAudit(params.randomXHeader, params.randomXKey, function (out_rx, out_rxroot) {

                    if (false)
                        console.log('\n *** source rxheader %s, rxkey %s, outrx %s, outrxroot %s \n', params.randomXHeader, params.randomXKey, out_rx, out_rxroot);

                    // Pull fresh random-x block
                    GetBlockForStratumHex(params.randomXKey, params.randomXHeader, function (error, blockSolution) {
                        if (error) {
                            emitErrorLog('Block notify error getting block template for ' + options.coin.name);
                        }
                        else {

                            GetAudit(blockSolution, function (s1, n1, s2, rpcBlockHash, n3) {

                                if (false)
                                    console.log('Got audit response with blockhash %s', rpcBlockHash);

                                var result = _this.jobManager.processShare(
                                    params.jobId,
                                    client.previousDifficulty,
                                    client.difficulty,
                                    nTimeInt,
                                    client.remoteAddress,
                                    client.socket.localPort,
                                    params.name,
                                    out_rx,
                                    params.randomXHeader,
                                    out_rxroot,
                                    options.address,
                                    params.randomXKey,
                                    blockSolution,
                                    params.in_rxhash,
                                    rpcBlockHash,
                                    params.xmrsuccess,
                                    params.xmrfail,
                                    params.xmrcharitysuccess,
                                    params.xmrcharityfail
                                );

                                resultCallback(result.error, result.result ? true : null);
                            });
                        }
                    })
                });
            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function () {
                //emitLog('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function (data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function () {
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }



    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(function () {
            GetBlockTemplate(false, function (error, result, foundNewBlock) {
                if (foundNewBlock) {
                    if (false) {
                        console.log('polling interval = %d', pollingInterval);
                        emitLog('Block notification::DiscoveredNewBlock via RPC2 polling');
                    }
                }
            });
        }, pollingInterval);
    }


    function GetBlockTemplate(needNewBlock, callback) {
        return GetBlockForStratum(options.address, needNewBlock, callback);
    }

    /*
    _this.daemon.cmd('getblocktemplate',
    [{ "capabilities": ["coinbasetxn", "workid", "coinbase/append"], "rules": ["segwit"]}],
    function (result) {
    if (result.error) {
    emitErrorLog('getblocktemplate call failed for daemon instance ' +
    result.instance.index + ' with error ' + JSON.stringify(result.error));
    callback(result.error);
    } else {
    var processedNewBlock = _this.jobManager.processTemplate(result.response);
    callback(null, result.response, processedNewBlock);
    callback = function () { };
    }
    }, true
    );
    }
    */



    // Support exporting hashrate data from nomp into a table, so users can see block history and block distribution
    function exportShareData(shareData, callback) {
        _this.daemon.performHTTPSRequest(shareData, 0, function (result, fgood) {
            callback(result, fgood);
        });
    }

    function GetAudit(blockHex, callback) {
        // console.log('calling hbtc %s ', blockHex);
        _this.daemon.cmd('hexblocktocoinbase', [blockHex],
                function (results) {
                    if (results.error) {
                        callback('fail');
                    }
                    else {
                        try {
                            var sRecipient = results[0].response.recipient;
                            var rxhash = results[0].response.biblehash;
                            var rpcBlockHash = results[0].response.blockhash;
                            var nTime = parseInt(results[0].response.nTime, 10);
                            callback(sRecipient, 1, rxhash, rpcBlockHash, nTime);
                        } catch (e) {
                            callback('', 0, '', '00', 0);
                        }
                    }
                }
       );
    }

    function GetBlockForStratumHex(rxkey, rxheader, callback) {
        _this.daemon.cmd('getblockforstratum', [options.address, rxkey, rxheader],
            function (result) {
                if (result.error) {
                    emitErrorLog('getblockforstratumHex call failed for daemon instance ' +
                        result.instance.index + ' with error ' + JSON.stringify(result.error));
                    callback(result.error);
                }
                else {
                    var sHex = result[0].response.hex;
                    callback(null, sHex);
                }
            }
        );
    }


    function GetBlockForStratum(poolAddress, needNewBlock, callback) {
        _this.daemon.cmd('getblockforstratum',
            [poolAddress],
            function (result) {
                if (result.error) {
                    emitErrorLog('getblockforstratum call failed for daemon instance ' +
                        result.instance.index + ' with error ' + JSON.stringify(result.error));
                    callback(result.error);
                } else {
                    var processedNewBlock = _this.jobManager.processGBT(result.response, needNewBlock);
                    callback(null, result.response, processedNewBlock);
                    callback = function () { };
                }
            }, true
       );
    }


    function GetRandomXAudit(rxheader, rxkey, callback) {
        // console.log('calling hbtc %s ', blockHex);
        // mutex here
        _this.daemon.cmd('exec', ['randomx_pool', rxheader, rxkey],
                function (results) {
                    if (results.error) {
                        callback('fail');
                    }
                    else {
                        try {
                            var rx = results[0].response.RX;
                            var rx_root = results[0].response.RX_root;
                            callback(rx, rx_root);
                        } catch (e) {
                            console.log(e.stack);
                            callback('na1', 'na2');
                        }
                    }
                }
            );
    }


    function GetPOBHHash(blockHash, callback) {
        var blockHash2 = util.reverseBuffer(blockHash);
        _this.daemon.cmd('getpobhhash', [blockHash2.toString('hex')],
                function (results) {
                    if (results.error) {
                        callback('fail');
                    }
                    else {
                        var sOutHash = results[0].response.outhash;
                        callback(sOutHash);
                    }
                }
            );
    }

    function CheckBlockAccepted(blockHash, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
                [blockHash],
                function (results) {
                    var validResults = results.filter(function (result) {
                        return result.response && (result.response.hash === blockHash)
                    });
                    if (validResults.length >= 1) {
                        // console.log('\n************* YAY resulting txid : %s ', validResults[0].response.tx[0]);
                        callback(true, validResults[0].response.tx[0]);
                    }
                    else {

                        callback(false);
                    }
                }
            );
        //}, 500);
    }



    /**
    * This method is being called from the blockNotify so that when a new block is discovered by the daemon
    * We can inform our miners about the newly found block
    **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        console.log('checking for new block ... %d', 701);
        emitLog('Block notification2 via ' + sourceTrigger);
        // We needed a more robust check here for BBP - because our blockhash is constantly changing, but our height is not
        if (true || (typeof (_this.jobManager.currentJob) !== 'undefined' && (blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash))) {
            GetBlockTemplate(false, function (error, result) {
                if (error)
                    emitErrorLog('Block notify error getting block template for ' + options.coin.name);
            })
        }
    };

    this.relinquishMiners = function (filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({ subId: subId, client: origStratumClients[subId] });
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function (cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        )
    };


    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof (_this.varDiff[port]) != 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        var varDiffInstance = new varDiff(port, varDiffConfig);
        _this.varDiff[port] = varDiffInstance;
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
            (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
            //Send new difficulty, then force miner to use new diff by resending the
            //current job parameters but with the "clean jobs" flag set to false
            //so the miner doesn't restart work and submit duplicate shares
            client.sendDifficulty(newDiff);
            var job = _this.jobManager.currentJob.getJobParams();
            job[8] = false;
            client.sendMiningJob(job);
            }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
