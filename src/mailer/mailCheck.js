/*
     .                              .o8                     oooo
   .o8                             "888                     `888
 .o888oo oooo d8b oooo  oooo   .oooo888   .ooooo.   .oooo.o  888  oooo
   888   `888""8P `888  `888  d88' `888  d88' `88b d88(  "8  888 .8P'
   888    888      888   888  888   888  888ooo888 `"Y88b.   888888.
   888 .  888      888   888  888   888  888    .o o.  )88b  888 `88b.
   "888" d888b     `V88V"V8P' `Y8bod88P" `Y8bod8P' 8""888P' o888o o888o
 ========================================================================
 Created:    06/19/2015
 Author:     Chris Brame

 **/

var _           = require('lodash');
var async       = require('async');
var Imap        = require('imap');
var winston     = require('winston');
// var marked      = require('marked');
var simpleParser = require('mailparser').simpleParser;

var emitter     = require('../emitter');
var userSchema  = require('../models/user');
var groupSchema = require('../models/group');
var ticketTypeSchema = require('../models/tickettype');
var Ticket      = require('../models/ticket');

var mailCheck = {};
mailCheck.inbox = [];

mailCheck.init = function(settings) {
    var s = {};
    s.mailerCheckEnabled = _.find(settings, function(x) { return x.name === 'mailer:check:enable' });
    s.mailerCheckHost = _.find(settings, function(x) { return x.name === 'mailer:check:host' });
    s.mailerCheckPort = _.find(settings, function(x) { return x.name === 'mailer:check:port' });
    s.mailerCheckUsername = _.find(settings, function(x) { return x.name === 'mailer:check:username' });
    s.mailerCheckPassword = _.find(settings, function(x) { return x.name === 'mailer:check:password' });
    s.mailerCheckPolling = _.find(settings, function(x) { return x.name === 'mailer:check:polling' });
    s.mailerCheckTicketType = _.find(settings, function(x) { return x.name === 'mailer:check:ticketype' });
    s.mailerCheckTicketPriority = _.find(settings, function(x) { return x.name === 'mailer:check:ticketpriority' });
    s.mailerCheckCreateAccount = _.find(settings, function(x) { return x.name === 'mailer:check:createaccount' });
    s.mailerCheckDeleteMessage = _.find(settings, function(x) { return x.name === 'mailer:check:deletemessage' });

    s.mailerCheckEnabled = (s.mailerCheckEnabled === undefined) ? {value: false} : s.mailerCheckEnabled;
    s.mailerCheckHost = (s.mailerCheckHost === undefined) ? {value: ''} : s.mailerCheckHost;
    s.mailerCheckPort = (s.mailerCheckPort === undefined) ? {value: 143} : s.mailerCheckPort;
    s.mailerCheckUsername = (s.mailerCheckUsername === undefined) ? {value: ''} : s.mailerCheckUsername;
    s.mailerCheckPassword = (s.mailerCheckPassword === undefined) ? {value: ''} : s.mailerCheckPassword;
    s.mailerCheckPolling = (s.mailerCheckPolling === undefined) ? {value: 600000} : s.mailerCheckPolling; //10 min
    s.mailerCheckTicketType = (s.mailerCheckTicketType === undefined) ? {value: 'Issue'} : s.mailerCheckTicketType;
    s.mailerCheckTicketPriority = (s.mailerCheckTicketPriority === undefined) ? {value: ''} : s.mailerCheckTicketPriority;
    s.mailerCheckCreateAccount = (s.mailerCheckCreateAccount === undefined) ? {value: false} : s.mailerCheckCreateAccount;
    s.mailerCheckDeleteMessage = (s.mailerCheckDeleteMessage === undefined) ? {value: false} : s.mailerCheckDeleteMessage;

    var MAILERCHECK_ENABLED = s.mailerCheckEnabled.value;
    var MAILERCHECK_HOST = s.mailerCheckHost.value;
    var MAILERCHECK_USER = s.mailerCheckUsername.value;
    var MAILERCHECK_PASS = s.mailerCheckPassword.value;
    var MAILERCHECK_PORT = s.mailerCheckPort.value;
    var MAILERCHECK_TLS = (s.mailerCheckPort.value === '993') ? {value: true} : false;
    var POLLING_INTERVAL = s.mailerCheckPolling.value;

    if (!MAILERCHECK_ENABLED) return true;

    mailCheck.Imap = new Imap({
        user: MAILERCHECK_USER,
        password: MAILERCHECK_PASS,
        host: MAILERCHECK_HOST,
        port: MAILERCHECK_PORT,
        tls: MAILERCHECK_TLS
    });

    mailCheck.fetchMailOptions = {
        defaultTicketType: s.mailerCheckTicketType.value,
        defaultPriority: s.mailerCheckTicketPriority.value,
        createAccount: s.mailerCheckCreateAccount.value,
        deleteMessage: s.mailerCheckDeleteMessage.value
    };

    mailCheck.fetchMail(mailCheck.fetchMailOptions);
    mailCheck.checkTimer = setInterval(function() {
        mailCheck.fetchMail(mailCheck.fetchMailOptions);
    }, POLLING_INTERVAL);
};

mailCheck.refetch = function() {
    mailCheck.fetchMail(mailCheck.fetchMailOptions);
};

mailCheck.fetchMail = function() {
    try {
        if (_.isUndefined(mailCheck.fetchMailOptions)) {
            winston.warn('Mailcheck.fetchMail() running before Mailcheck.init(); please run Mailcheck.init() prior');
            return;
        }

        var messages = [];

        mailCheck.Imap.once('error', function(err) {
            winston.debug(err);
        });

        mailCheck.Imap.once('ready', function() {
                openInbox(function (err, box) {
                    if (err) {
                        mailCheck.Imap.end();
                        winston.debug(err);
                    } else {
                        async.waterfall([
                            function (next) {
                                mailCheck.Imap.search(['UNSEEN'], next);
                            },
                            function (results, next) {
                                if (_.size(results) < 1) {
                                    winston.debug('MailCheck: Nothing to Fetch.');
                                    return next();
                                }

                                winston.debug('Processed %s Mail > Ticket', _.size(results));

                                var flag = '\\Seen';
                                if (mailCheck.fetchMailOptions.deleteMessage)
                                    flag = '\\Deleted';

                                mailCheck.Imap.addFlags(results, flag, function (err) {
                                    if (err) winston.warn(err);
                                });

                                var message = {};

                                var f = mailCheck.Imap.fetch(results, {
                                    bodies: ''
                                });

                                f.on('message', function (msg, seqno) {
                                    msg.on('body', function (stream) {
                                        var buffer = '';
                                        stream.on('data', function (chunk) {
                                            buffer += chunk.toString('utf8');
                                        });

                                        stream.once('end', function () {
                                            simpleParser(buffer, function (err, mail) {
                                                if (err) winston.warn(err);

                                                if (mail.headers.has('from')) {
                                                    message.from = mail.headers.get('from').value[0].address;
                                                }
                                                if (mail.subject) {
                                                    message.subject = mail.subject;
                                                } else {
                                                    message.subject = message.from;
                                                }

                                                message.body = mail.textAsHtml;

                                                messages.push(message);
                                            });
                                        });
                                    });

                                    f.once('end', function () {
                                        mailCheck.Imap.closeBox(true, function (err) {
                                            if (err) winston.warn(err);


                                            return next();
                                        });
                                    });
                                });
                            }
                        ], function (err) {
                            if (err) winston.warn(err);

                            mailCheck.Imap.end();
                        });
                    }
                });

        });

        mailCheck.Imap.once('end', function() {
            handleMessages(messages);
        });


        // Call Connect Last
        mailCheck.Imap.connect();

    } catch (err) {
        winston.warn(err);
        mailCheck.Imap.end();
    }
};


function handleMessages(messages) {
    messages.forEach(function(message) {
        if (!_.isUndefined(message.from) && !_.isEmpty(message.from) &&
            !_.isUndefined(message.subject) && !_.isEmpty(message.subject) &&
            !_.isUndefined(message.body) && !_.isEmpty(message.body)) {

            async.auto({
                handleUser: function (callback) {
                    userSchema.getUserByEmail(message.from, function (err, user) {
                        if (err) winston.warn(err);
                        if (!err && user) {
                            message.owner = user;
                            return callback(null, user);
                        } else {
                            //User doesn't exist. Lets create public user... If we want too
                            if (mailCheck.fetchMailOptions.createAccount) {
                                userSchema.createUserFromEmail(message.from, function (err, response) {
                                    if (err) return callback(err);

                                    message.owner = response.user;
                                    message.group = response.group;

                                    return callback(null, response);
                                });
                            } else {
                                return callback('No User found.');
                            }
                        }
                    })
                },
                handleGroup: ['handleUser', function (results, callback) {
                    if (!_.isUndefined(message.group))
                        return callback();

                    groupSchema.getAllGroupsOfUser(message.owner._id, function (err, group) {
                        if (err) return callback(err);
                        if (!group) return callback('Unknown group for user: ' + message.owner.email);

                        message.group = group;

                        return callback(null, group);
                    });
                }],
                handleTicketType: function (callback) {
                    if (mailCheck.fetchMailOptions.defaultTicketType === 'Issue') {
                        ticketTypeSchema.getTypeByName('Issue', function (err, type) {
                            if (err) return callback(err);

                            mailCheck.fetchMailOptions.defaultTicketType = type._id;
                            message.type = type;

                            return callback(null, type)
                        })
                    } else {
                        ticketTypeSchema.getType(mailCheck.fetchMailOptions.defaultTicketType, function (err, type) {
                            if (err) return callback(err);

                            message.type = type;

                            return callback(null, type);
                        });
                    }
                },
                handlePriority: ['handleTicketType', function (result, callback) {
                    var type = result.handleTicketType;

                    if (mailCheck.fetchMailOptions.defaultPriority !== '')
                        return callback(null, mailCheck.fetchMailOptions.defaultPriority);
                    else {
                        var firstPriority = _.first(type.priorities);
                        if (!_.isUndefined(firstPriority))
                            mailCheck.fetchMailOptions.defaultPriority = firstPriority._id;
                        else
                            return callback('Invalid default priority');

                        return callback(null, firstPriority._id);
                    }
                }],
                handleCreateTicket: ['handleGroup', 'handlePriority', function (results, callback) {

                    var HistoryItem = {
                        action: 'ticket:created',
                        description: 'Ticket was created.',
                        owner: message.owner._id
                    };

                    Ticket.create({
                        owner: message.owner._id,
                        group: message.group._id,
                        type: message.type._id,
                        status: 0,
                        priority: results.handlePriority,
                        subject: message.subject,
                        issue: message.body,
                        history: [HistoryItem]
                    }, function (err, ticket) {
                        if (err) {
                            winston.warn('Failed to create ticket from email: ' + err);
                            return callback(err);
                        }

                        emitter.emit('ticket:created', {
                            socketId: '',
                            ticket: ticket
                        });

                        return callback();
                    });
                }]
            }, function (err) {
                if (err) {
                    winston.debug(err);
                }


            });
        }
    });
}

function openInbox(cb) {
    mailCheck.Imap.openBox('INBOX', cb);
}
module.exports = mailCheck;

