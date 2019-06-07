/*
/*
 * This file is part of DAV-4-TbSync.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

"use strict";

var sync = {

    failed: function (msg = "", details = "") {
        let e = new Error();
        e.name = "dav4tbsync";
        e.message = tbSync.StatusData.WARNING + ": " + msg.toString() + " (" + details.toString() + ")";
        e.statusData = new tbSync.StatusData(tbSync.StatusData.WARNING, msg.toString(), details.toString());
        return e;
    },

    succeeded: function (msg = "") {
        let e = new Error();
        e.name = "dav4tbsync";
        e.message = tbSync.StatusData.SUCCESS + ": " + msg.toString();
        e.statusData = new tbSync.StatusData(tbSync.StatusData.SUCCESS, msg.toString());
        return e;
    },





    folderList: async function (syncData) {
        //Method description: http://sabre.io/dav/building-a-caldav-client/
        try {
            //get all folders currently known
            let folderTypes = ["caldav", "carddav", "ics"];
            let unhandledFolders = {};
            for (let type of folderTypes) {
                unhandledFolders[type] = [];
            }

            let folders = syncData.accountData.getAllFolders();
            for (let folder of folders) {
                //just in case
                if (!unhandledFolders.hasOwnProperty(folder.getFolderSetting("type"))) {
                    unhandledFolders[folder.getFolderSetting("type")] = [];
                }
                unhandledFolders[folder.getFolderSetting("type")].push(folder);
            }

            //get server urls from account setup - update urls of serviceproviders
            let serviceprovider = syncData.accountData.getAccountSetting("serviceprovider");
            if (dav.serviceproviders.hasOwnProperty(serviceprovider)) {
                syncData.accountData.setAccountSetting("host", dav.serviceproviders[serviceprovider].caldav.replace("https://","").replace("http://",""));
                syncData.accountData.setAccountSetting("host2", dav.serviceproviders[serviceprovider].carddav.replace("https://","").replace("http://",""));
            }

            let davjobs = {
                cal : {server: syncData.accountData.getAccountSetting("host")},
                card : {server: syncData.accountData.getAccountSetting("host2")},
            };
            
            for (let job in davjobs) {
                if (!davjobs[job].server) continue;
                
                //sync states are only printed while the account state is "syncing" to inform user about sync process (it is not stored in DB, just in syncData)
                //example state "getfolders" to get folder information from server
                //if you send a request to a server and thus have to wait for answer, use a "send." syncstate, which will give visual feedback to the user,
                //that we are waiting for an answer with timeout countdown

                let home = [];
                let own = [];
                let principal = null;

                //add connection to syncData
                syncData.connectionData = new dav.network.ConnectionData(syncData);
                
                //only do that, if a new calendar has been enabled
                tbSync.network.resetContainerForUser(syncData.connectionData.user);
                
                syncData.setSyncState("send.getfolders");
                {
                    //split server into fqdn and path
                    let parts = davjobs[job].server.split("/").filter(i => i != "");

                    syncData.connectionData.fqdn = parts.splice(0,1).toString();
                    syncData.connectionData.type = job;
                    
                    let path = "/" + parts.join("/");                
                    let response = await dav.network.sendRequest("<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:current-user-principal /></d:prop></d:propfind>", path , "PROPFIND", syncData.connectionData, {"Depth": "0", "Prefer": "return-minimal"});

                    syncData.setSyncState("eval.folders");
                    if (response && response.multi) principal = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], ["d","current-user-principal"], ["d","href"]]);
                }

                //principal now contains something like "/remote.php/carddav/principals/john.bieling/"
                // -> get home/root of storage
                if (principal !== null) {
                    syncData.setSyncState("send.getfolders");
                    
                    let homeset = (job == "cal")
                                            ? "calendar-home-set"
                                            : "addressbook-home-set";

                    let request = (job == "cal")
                                            ? "<d:propfind "+dav.tools.xmlns(["d", "cal", "cs"])+"><d:prop><cal:" + homeset + " /><cs:calendar-proxy-write-for /><cs:calendar-proxy-read-for /><d:group-membership /></d:prop></d:propfind>"
                                            : "<d:propfind "+dav.tools.xmlns(["d", "card"])+"><d:prop><card:" + homeset + " /><d:group-membership /></d:prop></d:propfind>";

                    let response = await dav.network.sendRequest(request, principal, "PROPFIND", syncData.connectionData, {"Depth": "0", "Prefer": "return-minimal"});

                    syncData.setSyncState("eval.folders");
                    own = dav.tools.getNodesTextContentFromMultiResponse(response, [["d","prop"], [job, homeset ], ["d","href"]], principal);
                    home = own.concat(dav.tools.getNodesTextContentFromMultiResponse(response, [["d","prop"], ["cs", "calendar-proxy-read-for" ], ["d","href"]], principal));
                    home = home.concat(dav.tools.getNodesTextContentFromMultiResponse(response, [["d","prop"], ["cs", "calendar-proxy-write-for" ], ["d","href"]], principal));

                    //Any groups we need to find? Only diving one level at the moment, 
                    let g = dav.tools.getNodesTextContentFromMultiResponse(response, [["d","prop"], ["d", "group-membership" ], ["d","href"]], principal);
                    for (let gc=0; gc < g.length; gc++) {
                        //SOGo reports a 403 if I request the provided resource, also since we do not dive, remove the request for group-membership                    
                        response = await dav.network.sendRequest(request.replace("<d:group-membership />",""), g[gc], "PROPFIND", syncData.connectionData, {"Depth": "0", "Prefer": "return-minimal"}, {softfail: [403, 404]});
                        if (response && response.softerror) {
                            continue;
                        }		    
                        home = home.concat(dav.tools.getNodesTextContentFromMultiResponse(response, [["d","prop"], [job, homeset ], ["d","href"]], g[gc]));
                    }

                    //calendar-proxy and group-membership could have returned the same values, make the homeset unique
                    home = home.filter((v,i,a) => a.indexOf(v) == i);
                } else {
                    throw dav.sync.failed(job+"davservernotfound", davjobs[job].server)
                }

                //home now contains something like /remote.php/caldav/calendars/john.bieling/
                // -> get all resources
                if (home.length > 0) {
                    for (let h=0; h < home.length; h++) {
                        syncData.setSyncState("send.getfolders");
                        let request = (job == "cal")
                                                ? "<d:propfind "+dav.tools.xmlns(["d","apple","cs"])+"><d:prop><d:current-user-privilege-set/><d:resourcetype /><d:displayname /><apple:calendar-color/><cs:source/></d:prop></d:propfind>"
                                                : "<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:current-user-privilege-set/><d:resourcetype /><d:displayname /></d:prop></d:propfind>";

                        //some servers report to have calendar-proxy-read but return a 404 when that gets actually queried
                        let response = await dav.network.sendRequest(request, home[h], "PROPFIND", syncData.connectionData, {"Depth": "1", "Prefer": "return-minimal"}, {softfail: [403, 404]});
                        if (response && response.softerror) {
                            continue;
                        }
                        
                        for (let r=0; r < response.multi.length; r++) {
                            if (response.multi[r].status != "200") continue;
                            
                            let resourcetype = null;
                            //is this a result with a valid recourcetype? (the node must be present)
                            switch (job) {
                                case "card": 
                                        if (dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","resourcetype"], ["card", "addressbook"]]) !== null) resourcetype = "carddav";
                                    break;
                                    
                                case "cal":
                                        if (dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","resourcetype"], ["cal", "calendar"]]) !== null) resourcetype = "caldav";
                                        else if (dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","resourcetype"], ["cs", "subscribed"]]) !== null) resourcetype = "ics";
                                    break;
                            }
                            if (resourcetype === null) continue;
                            
                            //get ACL
                            let acl = 0;
                            let privilegNode = dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","current-user-privilege-set"]]);
                            if (privilegNode) {
                                if (privilegNode.getElementsByTagNameNS(dav.ns.d, "all").length > 0) { 
                                    acl = 0xF; //read=1, mod=2, create=4, delete=8 
                                } else if (privilegNode.getElementsByTagNameNS(dav.ns.d, "read").length > 0) { 
                                    acl = 0x1;
                                    if (privilegNode.getElementsByTagNameNS(dav.ns.d, "write").length > 0) {
                                        acl = 0xF; 
                                    } else {
                                        if (privilegNode.getElementsByTagNameNS(dav.ns.d, "write-content").length > 0) acl |= 0x2;
                                        if (privilegNode.getElementsByTagNameNS(dav.ns.d, "bind").length > 0) acl |= 0x4;
                                        if (privilegNode.getElementsByTagNameNS(dav.ns.d, "unbind").length > 0) acl |= 0x8;
                                    }
                                }
                            }
                            
                            //ignore this resource, if no read access
                            if ((acl & 0x1) == 0) continue;

                            let href = response.multi[r].href;
                            if (resourcetype == "ics") href =  dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["cs","source"], ["d","href"]]).textContent;
                            
                            let name_node = dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","displayname"]]);
                            let name = tbSync.getString("defaultname." +  ((job == "cal") ? "calendar" : "contacts") , "dav");
                            if (name_node != null) {
                                name = name_node.textContent;
                            }
                            let color = dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["apple","calendar-color"]]);

                            //remove found folder from list of unhandled folders
                            unhandledFolders[resourcetype] = unhandledFolders[resourcetype].filter(item => item.getFolderSetting("href") !== href);

                            
                            // interaction with TbSync
                            // do we have a folder for that href?
                            let folderData = syncData.accountData.getFolder("href", href);
                            if (!folderData) {
                                // create a new folder entry
                                folderData = syncData.accountData.createNewFolder();
                                // this MUST be set to either "addressbook" or "calendar" to use the standard target support, or any other value, which 
                                // requires a corresponding targets implementation by this provider
                                folderData.setFolderSetting("targetType", (job == "card") ? "addressbook" : "calendar");
                                
                                folderData.setFolderSetting("href", href);
                                folderData.setFolderSetting("name", name);
                                folderData.setFolderSetting("type", resourcetype);
                                folderData.setFolderSetting("shared", (own.includes(home[h])) ? "0" : "1");
                                folderData.setFolderSetting("acl", acl.toString());
                                folderData.setFolderSetting("downloadonly", (acl == 0x1) ? "1" : "0"); //if any write access is granted, setup as writeable

                                //we assume the folder has the same fqdn as the homeset, otherwise href must contain the full URL and the fqdn is ignored
                                folderData.setFolderSetting("fqdn", syncData.connectionData.fqdn);
                                
                                //do we have a cached folder?
                                let cachedFolderData = syncData.accountData.getFolderFromCache("href", href);
                                if (cachedFolderData) {
                                    // copy fields from cache which we want to re-use
                                    folderData.setFolderSetting("targetColor", cachedFolderData.getFolderSetting("targetColor"));
                                    folderData.setFolderSetting("targetName", cachedFolderData.getFolderSetting("targetName"));
                                    let cachedDownloadOnly = cachedFolderData.getFolderSetting("downloadonly");
                                    //if we have only READ access, do not restore cached value for downloadonly
                                    if (acl > 0x1) folderData.setFolderSetting("downloadonly", cachedFolderData.getFolderSetting("downloadonly"));
                                }
                            } else {
                                //Update name & color
                                folderData.setFolderSetting("name", name);
                                folderData.setFolderSetting("fqdn", syncData.connectionData.fqdn);
                                folderData.setFolderSetting("acl", acl);
                                //if the acl changed from RW to RO we need to update the downloadonly setting
                                if (acl == 0x1) {
                                    folderData.setFolderSetting("downloadonly", "1");
                                }
                            }

                            //update color from server
                            if (color && job == "cal") {
                                color = color.textContent.substring(0,7);
                                folderData.setFolderSetting("targetColor", color);
                                
                                //do we have to update the calendar? Get the raw cal object
                                let targetCal = folderData.targetData.checkTarget();
                                if (targetCal) {
                                    targetCal.setProperty("color", color);
                                }
                            }
                        }
                    }
                } else {
                    //home was not found - connection error? - do not delete unhandled folders
                    switch (job) {
                        case "card": 
                                unhandledFolders.carddav = [];
                            break;
                            
                        case "cal":
                                unhandledFolders.caldav = [];
                                unhandledFolders.ics = [];
                            break;
                    }
                }
            }

            //remove unhandled old folders, (because they no longer exist on the server)
            for (let type of folderTypes) {
                for (let folder of unhandledFolders[type]) {
                    folder.targetData.decoupleTarget("[deleted on server]", /* cache em */ true);
                }
            }
        } catch (e) {
            if (e.name == "dav4tbsync") {
                return e.statusData;
            } else {
                Components.utils.reportError(e);
                return new tbSync.StatusData(tbSync.StatusData.WARNING, "JavaScriptError", e.message + "\n\n" + e.stack);
            }
        }
        // we fall through, if there was no error
        return new tbSync.StatusData();
    },






    folder: async function (syncData) {
        try {
            
            // add connection data to syncData
            syncData.connectionData = new dav.network.ConnectionData(syncData);

            // add target to syncData
            try {
                // accessing the target for the first time will check if it is avail and if not will create it (if possible)
                syncData.target = syncData.currentFolderData.targetData.getTarget();
            } catch (e) {
                throw dav.sync.failed(e.message);
            }
            
            switch (syncData.connectionData.type) {
                case "carddav":
                    {
                        await dav.sync.singleFolder(syncData);
                    }
                    break;

                case "caldav":
                case "ics":
                    {
                        //update downloadonly
                        if (syncData.currentFolderData.getFolderSetting("downloadonly") == "1") syncData.target.setProperty("readOnly", true);

                        //init sync via lightning
                        syncData.target.refresh();

                        throw dav.sync.succeeded("managed-by-lightning");
                    }
                    break;

                default:
                    {
                        throw dav.sync.failed("notsupported");
                    }
                    break;
            }
        } catch (e) {
            if (e.name == "dav4tbsync") {
                return e.statusData;
            } else {
                Components.utils.reportError(e);
                return new tbSync.StatusData(tbSync.StatusData.WARNING, "JavaScriptError", e.message + "\n\n" + e.stack);
            }
        }
        throw new Error("Should not happen!");
    },


    singleFolder: async function (syncData)  {
        let downloadonly = (syncData.currentFolderData.getFolderSetting("downloadonly") == "1");
        
        await dav.sync.remoteChanges(syncData);
        let numOfLocalChanges = await dav.sync.localChanges(syncData);

        //revert all local changes on permission error by doing a clean sync
        if (numOfLocalChanges < 0) {
            dav.onResetTarget(syncData);
            await dav.sync.remoteChanges(syncData);

            if (!downloadonly) throw dav.sync.failed("info.restored");
        } else if (numOfLocalChanges > 0){
            //we will get back our own changes and can store etags and vcards and also get a clean ctag/token
            await dav.sync.remoteChanges(syncData);
        }

        //always finish sync by throwing failed or succeeded
        throw dav.sync.succeeded();
    },










    remoteChanges: async function (syncData) {
        //Do we have a sync token? No? -> Initial Sync (or WebDAV sync not supported) / Yes? -> Get updates only (token only present if WebDAV sync is suported)
        let token = syncData.currentFolderData.getFolderSetting("token");
        if (token) {
            //update via token sync
            let tokenSyncSucceeded = await dav.sync.remoteChangesByTOKEN(syncData);
            if (tokenSyncSucceeded) return;

            //token sync failed, reset ctag and token and do a full sync
            dav.onResetTarget(syncData);
        }

        //Either token sync did not work or there is no token (initial sync)
        //loop until ctag is the same before and after polling data (sane start condition)
        let maxloops = 20;
        for (let i=0; i <= maxloops; i++) {
                if (i == maxloops)
                    throw dav.sync.failed("could-not-get-stable-ctag");

                let ctagChanged = await dav.sync.remoteChangesByCTAG(syncData);
                if (!ctagChanged) break;
        }
    },

    remoteChangesByTOKEN: async function (syncData) {
        syncData.progressData.reset();

        let token = syncData.currentFolderData.getFolderSetting("token");
        syncData.setSyncState("send.request.remotechanges");
        let cards = await dav.network.sendRequest("<d:sync-collection "+dav.tools.xmlns(["d"])+"><d:sync-token>"+token+"</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>", syncData.currentFolderData.getFolderSetting("href"), "REPORT", syncData.connectionData, {}, {softfail: [415,403]});

        //Sabre\DAV\Exception\ReportNotSupported - Unsupported media type - returned by fruux if synctoken is 0 (empty book), 415 & 403
        //https://github.com/sabre-io/dav/issues/1075
        //Sabre\DAV\Exception\InvalidSyncToken (403)
        if (cards && cards.softerror) {
            //token sync failed, reset ctag and do a full sync
            return false;
        }

        let tokenNode = dav.tools.evaluateNode(cards.node, [["d", "sync-token"]]);
        if (tokenNode === null) {
            //token sync failed, reset ctag and do a full sync
            return false;
        }

        let vCardsDeletedOnServer = [];
        let vCardsChangedOnServer = {};
        
        let localDeletes = syncData.target.getDeletedItemsFromChangeLog();
        
        let cardsFound = 0;
        for (let c=0; c < cards.multi.length; c++) {
            let id = cards.multi[c].href;
            if (id !==null) {
                //valid
                let card = syncData.target.getItemFromProperty("X-DAV-HREF", id);
                if (cards.multi[c].status == "200") {
                    //MOD or ADD
                    let etag = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getetag"]]);
                    if (!card) {
                        //if the user deleted this card (not yet send to server), do not add it again
                        if (!localDeletes.includes(id))  { 
                            cardsFound++;
                            vCardsChangedOnServer[id] = "ADD"; 
                        }
                    } else if (etag.textContent != card.getProperty("X-DAV-ETAG")) {
                        cardsFound++;
                        vCardsChangedOnServer[id] = "MOD"; 
                    }
                } else if (cards.multi[c].responsestatus == "404" && card) {
                    //DEL
                    cardsFound++;
                    vCardsDeletedOnServer.push(card);
                } else {
                    //We received something, that is not a DEL, MOD or ADD
                    tbSync.errorlog.add("warning", syncData.errorOwnerData, "Unknown XML", JSON.stringify(cards.multi[c]));
                }
            }
        }

        // reset sync process
        syncData.progressData.reset(0, cardsFound);

        //download all cards added to vCardsChangedOnServer and process changes
        await dav.sync.multiget(syncData, vCardsChangedOnServer);

        //delete all contacts added to vCardsDeletedOnServer
        await dav.sync.deleteContacts (syncData, vCardsDeletedOnServer);

        //update token
        syncData.currentFolderData.setFolderSetting("token", tokenNode.textContent);

        return true;
    },

    remoteChangesByCTAG: async function (syncData) {
        syncData.progressData.reset();

        //Request ctag and token
        syncData.setSyncState("send.request.remotechanges");
        let response = await dav.network.sendRequest("<d:propfind "+dav.tools.xmlns(["d", "cs"])+"><d:prop><cs:getctag /><d:sync-token /></d:prop></d:propfind>", syncData.currentFolderData.getFolderSetting("href"), "PROPFIND", syncData.connectionData, {"Depth": "0"});

        syncData.setSyncState("eval.response.remotechanges");
        let ctag = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], ["cs", "getctag"]], syncData.currentFolderData.getFolderSetting("href"));
        let token = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], ["d", "sync-token"]], syncData.currentFolderData.getFolderSetting("href"));

        let localDeletes = syncData.target.getDeletedItemsFromChangeLog();

        //if CTAG changed, we need to sync everything and compare
        if (ctag === null || ctag != syncData.currentFolderData.getFolderSetting("ctag")) {
            let vCardsFoundOnServer = [];
            let vCardsChangedOnServer = {};

            //get etags of all cards on server and find the changed cards
            syncData.setSyncState("send.request.remotechanges");
            let cards = await dav.network.sendRequest("<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:getetag /></d:prop></d:propfind>", syncData.currentFolderData.getFolderSetting("href"), "PROPFIND", syncData.connectionData, {"Depth": "1", "Prefer": "return-minimal"});
            
            //to test other impl
            //let cards = await dav.network.sendRequest("<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:getetag /></d:prop></d:propfind>", syncData.currentFolderData.getFolderSetting("href"), "PROPFIND", syncData.connectionData, {"Depth": "1", "Prefer": "return-minimal"}, {softfail: []}, false);

            //this is the same request, but includes getcontenttype, do we need it? icloud send contacts without
            //let cards = await dav.network.sendRequest("<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:getetag /><d:getcontenttype /></d:prop></d:propfind>", syncData.currentFolderData.getFolderSetting("href"), "PROPFIND", syncData.connectionData, {"Depth": "1", "Prefer": "return-minimal"});

            //play with filters and limits for synology
            /*
            let additional = "<card:limit><card:nresults>10</card:nresults></card:limit>";
            additional += "<card:filter test='anyof'>";
                additional += "<card:prop-filter name='FN'>";
                    additional += "<card:text-match negate-condition='yes' match-type='equals'>bogusxy</card:text-match>";
                additional += "</card:prop-filter>";
            additional += "</card:filter>";*/
        
            //addressbook-query does not work on older servers (zimbra)
            //let cards = await dav.network.sendRequest("<card:addressbook-query "+dav.tools.xmlns(["d", "card"])+"><d:prop><d:getetag /></d:prop></card:addressbook-query>", syncData.currentFolderData.getFolderSetting("href"), "REPORT", syncData.connectionData, {"Depth": "1", "Prefer": "return-minimal"});

            syncData.setSyncState("eval.response.remotechanges");
            let cardsFound = 0;
            for (let c=0; cards.multi && c < cards.multi.length; c++) {
                let id =  cards.multi[c].href;
                if (id == syncData.currentFolderData.getFolderSetting("href")) {
                    //some servers (Radicale) report the folder itself and a querry to that would return everything again
                    continue;
                }
                let etag = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getetag"]]);

                //ctype is currently not used, because iCloud does not send one and sabre/dav documentation is not checking ctype 
                //let ctype = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getcontenttype"]]);

                if (cards.multi[c].status == "200" && etag !== null && id !== null /* && ctype !== null */) { //we do not actually check the content of ctype - but why do we request it? iCloud seems to send cards without ctype
                    vCardsFoundOnServer.push(id);
                    let card = syncData.target.getItemFromProperty("X-DAV-HREF", id);
                    if (!card) {
                        //if the user deleted this card (not yet send to server), do not add it again
                        if (!localDeletes.includes(id)) {
                            cardsFound++;
                            vCardsChangedOnServer[id] = "ADD"; 
                        }
                    } else if (etag.textContent != card.getProperty("X-DAV-ETAG")) {
                        cardsFound++;
                        vCardsChangedOnServer[id] = "MOD"; 
                    }
                }
            }

            //FIND DELETES: loop over current addressbook and check each local card if it still exists on the server
            let vCardsDeletedOnServer = [];
            cards = syncData.target.childCards;
            let localAdditions = syncData.target.getAddedItemsFromChangeLog();
            while (true) {
                let more = false;
                try { more = cards.hasMoreElements() } catch (ex) {}
                if (!more) break;

                let card = cards.getNext().QueryInterface(Components.interfaces.nsIAbCard);
                let id = card.getProperty("X-DAV-HREF");
                if (id && !vCardsFoundOnServer.includes(id) && !localAdditions.includes(id)) {
                    //delete request from server
                    cardsFound++;
                    vCardsDeletedOnServer.push(card);
                }
            }

            // reset sync process
            syncData.progressData.reset(0, cardsFound);

            //download all cards added to vCardsChangedOnServer and process changes
            await dav.sync.multiget(syncData, vCardsChangedOnServer);

            //delete all contacts added to vCardsDeletedOnServer
            await dav.sync.deleteContacts (syncData, vCardsDeletedOnServer);

            //update ctag and token (if there is one)
            if (ctag === null) return false; //if server does not support ctag, "it did not change"
            syncData.currentFolderData.setFolderSetting("ctag", ctag);
            if (token) syncData.currentFolderData.setFolderSetting("token", token);

            //ctag did change
            return true;
        } else {

            //ctag did not change
            return false;
        }

    },



    multiget: async function (syncData, vCardsChangedOnServer) {
        //keep track of found mailing lists and its members
        syncData.foundMailingListsDuringDownSync = {};
        
        //download all changed cards and process changes
        let cards2catch = Object.keys(vCardsChangedOnServer);
        let maxitems = dav.prefSettings.getIntPref("maxitems");

        for (let i=0; i < cards2catch.length; i+=maxitems) {
            let request = dav.tools.getMultiGetRequest(cards2catch.slice(i, i+maxitems));
            if (request) {
                syncData.setSyncState("send.request.remotechanges");
                let cards = await dav.network.sendRequest(request, syncData.currentFolderData.getFolderSetting("href"), "REPORT", syncData.connectionData, {"Depth": "1"});

                syncData.setSyncState("eval.response.remotechanges");
                for (let c=0; c < cards.multi.length; c++) {
                    syncData.progressData.inc();
                    let id =  cards.multi[c].href;
                    let etag = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getetag"]]);
                    let data = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["card","address-data"]]);

                    if (cards.multi[c].status == "200" && etag !== null && data !== null && id !== null && vCardsChangedOnServer.hasOwnProperty(id)) {
                        switch (vCardsChangedOnServer[id]) {
                            case "ADD":
                                dav.tools.addContact (syncData, id, data, etag);
                                break;

                            case "MOD":
                                dav.tools.modifyContact (syncData, id, data, etag);
                                break;
                        }
                        //Feedback from users: They want to see the individual count
                        syncData.setSyncState("eval.response.remotechanges");		
                        await tbSync.tools.sleep(100, false);
                    } else {
                        tbSync.dump("Skipped Card", [id, cards.multi[c].status == "200", etag !== null, data !== null, id !== null, vCardsChangedOnServer.hasOwnProperty(id)].join(", "));
                    }
                }
            }
        }
        // Feedback from users: They want to see the final count.
        syncData.setSyncState("eval.response.remotechanges");		
        await tbSync.tools.sleep(200, false);
    
        let syncGroups = (syncData.accountData.getAccountSetting("syncGroups") == "1");
        if (syncGroups) {
            // Mailinglists, we need to do that at the very end so all member data is avail.
            for (let listID in syncData.foundMailingListsDuringDownSync) {
                if (syncData.foundMailingListsDuringDownSync.hasOwnProperty(listID)) {
                    let list = syncData.target.getItemFromProperty("X-DAV-HREF", listID);
                    if (!list.isMailList)
                        continue;
                    
                    let currentMembers = list.getMembersPropertyList("X-DAV-UID");
                    
                    //CardInfo contains the name and the X-DAV-UID list of the members
                    let vCardInfo = dav.tools.getGroupInfoFromCardData(syncData.foundMailingListsDuringDownSync[listID].vCardData, syncData.target);
                    let oCardInfo = dav.tools.getGroupInfoFromCardData(syncData.foundMailingListsDuringDownSync[listID].oCardData, syncData.target);

                    // Smart merge: oCardInfo contains the state during last sync, vCardInfo is the current state.
                    // By comparing we can learn, which member was deleted by the server (in old but not in new).
                    let removedMembers = oCardInfo.members.filter(e => !vCardInfo.members.includes(e));
                     
                    // The new list from the server is taken.
                    let newMembers = vCardInfo.members;
        Services.console.logStringMessage("[1] " + newMembers.toString());
                    
                    // Any member in current but not in new is added.
                    for (let member of currentMembers) {
                        if (!newMembers.includes(member) && !removedMembers.includes(member)) 
                            newMembers.push(member);
                    }
        Services.console.logStringMessage("[2] " + newMembers.toString());

                    // Remove local deletes.
                    for (let member of oCardInfo.members) {
                        if (!currentMembers.includes(member)) 
                            newMembers = newMembers.filter(e => e != member);
                    }
                    
                    //let addedMembers = vCardInfo.members.filter(e => !oCardInfo.members.includes(e));
        Services.console.logStringMessage("[3] " + newMembers.toString());
                    
                    list.setMembersByPropertyList("X-DAV-UID", newMembers);
                }
            }
        }            
    },

    deleteContacts: async function (syncData, cards2delete) {
        let maxitems = dav.prefSettings.getIntPref("maxitems");

        // try to show a progress based on maxitens during delete and not delete all at once
        for (let i=0; i < cards2delete.length; i+=maxitems) {
            //get size of next block
            let remain = (cards2delete.length - i);
            let chunk = Math.min(remain, maxitems);

            syncData.progressData.inc(chunk);
            syncData.setSyncState("eval.response.remotechanges");
            await tbSync.tools.sleep(200); //we want the user to see, that deletes are happening

            for (let j=0; j < chunk; j++) {
                syncData.target.remove(cards2delete[i+j]);
            }
        }
    },




    localChanges: async function (syncData) {
        //keep track of found mailing lists and its members
        syncData.foundMailingListsDuringUpSync = {};

        //define how many entries can be send in one request
        let maxitems = dav.prefSettings.getIntPref("maxitems");

        let downloadonly = (syncData.currentFolderData.getFolderSetting("downloadonly") == "1");

        let permissionErrors = 0;
        let permissionError = { //keep track of permission errors - preset with downloadonly status to skip sync in that case
            "added_by_user": downloadonly, 
            "modified_by_user": downloadonly, 
            "deleted_by_user": downloadonly
        }; 
        
        let syncGroups = (syncData.accountData.getAccountSetting("syncGroups") == "1");
        if (syncGroups && 1==2) {
            //special handling of lists/groups
            //ADD/MOD of the list cards itself is not detectable, we only detect the change of its member cards when membership changes
            //DEL is handled like a normal card, no special handling needed        
            let result = MailServices.ab.getDirectory(syncData.target.URI +  "?(or(IsMailList,=,TRUE))").childCards;
            while (result.hasMoreElements()) {
                let mailListCard = result.getNext().QueryInterface(Components.interfaces.nsIAbCard);
                let mailListInfo = dav.tools.getGroupInfoFromList(mailListCard.mailListURI);           

                let mailListCardId = mailListCard.getProperty("X-DAV-HREF");
                if (mailListCardId) {
                    //get old data from vCard to find changes
                    let oCardInfo = dav.tools.getGroupInfoFromCardData(dav.vCard.parse(mailListCard.getProperty("X-DAV-VCARD")), syncData.target);            
                    
                    let addedMembers = mailListInfo.members.filter(e => !oCardInfo.members.includes(e));
                    let removedMembers = oCardInfo.members.filter(e => !mailListInfo.members.includes(e));
                    
                    if (oCardInfo.name != mailListInfo.name || addedMembers.length > 0 || removedMembers.length > 0) {
                        tbSync.db.addItemToChangeLog(syncData.currentFolderData.getFolderSetting("target"), mailListCardId, "modified_by_user");
                    }
                } else {
                    //that listcard has no id yet (because the general TbSync addressbook listener cannot catch it)
                    let folder = tbSync.db.getFolder(syncData.account, syncData.folderID); //M�����P
                    mailListCardId = dav.getNewCardID(mailListCard, folder);
                    mailListCard.setProperty("X-DAV-HREF", mailListCardId);                
                    tbSync.db.addItemToChangeLog(syncData.currentFolderData.getFolderSetting("target"), mailListCardId, "added_by_user");
                }
                syncData.foundMailingListsDuringUpSync[mailListCardId] = mailListInfo;
            }
        }
        
        //access changelog to get local modifications (done and todo are used for UI to display progress)
        syncData.progressData.reset(0, syncData.target.getItemsFromChangeLog().length);

        do {
            syncData.setSyncState("prepare.request.localchanges");

            //get changed items from ChangeLog 
            let changes = syncData.target.getItemsFromChangeLog(maxitems);
            if (changes.length == 0)
                break;

            for (let i=0; i < changes.length; i++) {
                switch (changes[i].status) {
                    case "added_by_user":
                    case "modified_by_user":
                        {
                            let isAdding = (changes[i].status == "added_by_user");
                            if (!permissionError[changes[i].status]) { //if this operation failed already, do not retry

                                let card = changes[i].card;
                                if (card) {
                                    if (card.isMailList && !syncGroups)
                                        continue;
                                    
                                    let vcard = card.isMailList
                                                        ? dav.tools.getVCardFromThunderbirdListCard(syncData, card, isAdding)
                                                        : dav.tools.getVCardFromThunderbirdContactCard(syncData, card, isAdding);
                                    let headers = {"Content-Type": "text/vcard; charset=utf-8"};
                                    //if (!isAdding) options["If-Match"] = vcard.etag;

                                    syncData.setSyncState("send.request.localchanges");
                                    if (isAdding || vcard.modified) {
                                        let response = await dav.network.sendRequest(vcard.data, card.getProperty("X-DAV-HREF"), "PUT", syncData.connectionData, headers, {softfail: [403,405]});

                                        syncData.setSyncState("eval.response.localchanges");
                                        if (response && response.softerror) {
                                            permissionError[changes[i].status] = true;
                                            tbSync.errorlog.add("warning", syncData.errorOwnerData, "missing-permission::" + tbSync.getString(isAdding ? "acl.add" : "acl.modify", "dav"));
                                        }
                                    }
                                } else {
                                    tbSync.errorlog.add("warning", syncData.errorOwnerData, "cardnotfoundbutinchangelog::" + changes[i].id + "/" + changes[i].status);
                                }
                            }

                            if (permissionError[changes[i].status]) {
                                //we where not allowed to add or modify that card, remove it, we will get a fresh copy on the following revert
                                syncData.target.remove(card);
                                permissionErrors++;
                            }
                        }
                        break;

                    case "deleted_by_user":
                        {
                            if (!permissionError[changes[i].status]) { //if this operation failed already, do not retry
                                syncData.setSyncState("send.request.localchanges");
                                let response = await dav.network.sendRequest("", changes[i].id , "DELETE", syncData.connectionData, {}, {softfail: [403, 404, 405]});

                                syncData.setSyncState("eval.response.localchanges");
                                if (response  && response.softerror) {
                                    if (response.softerror != 404) { //we cannot do anything about a 404 on delete, the card has been deleted here and is not avail on server
                                        permissionError[changes[i].status] = true;
                                        tbSync.errorlog.add("warning", syncData.errorOwnerData, "missing-permission::" + tbSync.getString("acl.delete", "dav"));
                                    }
                                }
                            }

                            if (permissionError[changes[i].status]) {
                                permissionErrors++;                                
                            }
                        }
                        break;
                }

                syncData.target.removeItemFromChangeLog(changes[i].id);                
                syncData.progressData.inc(); //UI feedback
            }


        } while (true);

        //return number of modified cards or the number of permission errors (negativ)
        return (permissionErrors > 0 ? 0 - permissionErrors : syncData.progressData.done);
    },
}
