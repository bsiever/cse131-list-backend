import {DynamoDBGetParams, performGet, DynamoDBQueryParams, performQuery, DynamoDBUpdateParams, performUpdate, DynamoDBPutParams, performPut, updateUser } from './database';
import {ErrorTypes, GeneratedError} from './responses';
const AWS = require('aws-sdk');
const randtoken = require('rand-token');
const https = require('https')
const tokenMinutesTimeout = 90;
const fromEmail = process.env.EMAIL


export interface User {
    id: string
    userToken?: string,
    tokenTime?: number,
    classes: string[] | {[s: string]: string}[]
    fullName: string
    username: string
    admin: boolean
}

export interface SessionObj {
    sessionName: string,
    lists: {[s: string]: string} //Maps id to name
}

export interface ClassObj {
    id: string,
    classUsers: {},
    className: string,
    userCode: string,
    taCode: string,
    adminCode: string,
    sessions: {[s: string]: SessionObj}, //Maps id to SessionObj
    remoteMode: boolean,
    imageID?: string
}


export const enum PermissionLevel {
    Student,
    TA,
    Professor
}

/*User functions for authentication*/

const makeRequest = async (options: object, dataToPost: string): Promise<string> => {
    return await new Promise((resolve , reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let result = '';
            res.on('data', function (chunk) {
                result+=chunk;
            });
            res.on('end',function(){
                resolve(result);
            })
        });

        req.on('error', (e) => {
          reject(e.message);
        });

        // send the request
        if(dataToPost) req.write(dataToPost);
        req.end();
    });
}
export const validateLoginRequest = async (data: any): Promise<User> => {
    validate(data.client_code,"string","client_code",1);
    const dataToPost = `client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}&code=${data.client_code}`;
    const options = {
        host: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: {
            'Content-Length': Buffer.byteLength(dataToPost)
        }
    };
    const getTokenResult: string = await makeRequest(options,dataToPost);

    const regex = new RegExp('^.*access_token=([^&]*)&.*token_type=bearer$')
    console.log(getTokenResult)
    const found = getTokenResult.match(regex);
    if(!found) {
        throw new GeneratedError(ErrorTypes.InvalidLogin);
    }
    const apiToken = found[1];
    const optionsGetEmails = {
        host: 'api.github.com',
        path: '/user/emails',
        method: 'GET',
        headers: {
            'Authorization': 'token '+apiToken,
            'User-Agent':  'CSE131HelpList'
        }
    }

    const getEmailsResult: string = await makeRequest(optionsGetEmails,null);
    
    interface email {
        email: string,
        primary: boolean,
        verified: boolean,
        visibility: string
    }
    const emails: email[] = JSON.parse(getEmailsResult);

    console.log(emails)
    let userEmail = null;
    for(let email of emails) {
        if(email.email.slice(-10).toLowerCase() === '@wustl.edu') {
            userEmail = email.email.toLowerCase();
            break;
        }
    }
    if(!userEmail) {
        throw new GeneratedError(ErrorTypes.InvalidLogin);
    }

    const optionsGetName = {
        host: 'api.github.com',
        path: '/user',
        method: 'GET',
        headers: {
            'Authorization': 'token '+apiToken,
            'User-Agent':  'CSE131HelpList'
        }
    }

    const getFullNameResult: string = await makeRequest(optionsGetName,null);
    let userFullName = JSON.parse(getFullNameResult).name;
    if(userFullName === null) {
        userFullName = userEmail.slice(0,userEmail.length-10); //Just make start of email
    }
    let result: User = await getUserByUsername(userEmail,true);
    if(result === null) {
        result = await createUser(userEmail,false,userFullName);
    }

    result.userToken = randtoken.generate(32);
    await updateToken(result.id, result.userToken);
    result.classes = await Promise.all((result.classes as string[]).map(async id=>{
        try {
          const className =  await getClassName(id);
          return {id, className}
        } catch(e) {
          console.log("Error Invalid Class")
          console.log(result.id)
          console.log(id)
          return null;
        }
    }))
    result.classes = result.classes.filter(i=>i!=null)
    return result;
}

export const validateTokenRequest = async (data: any, requireAdmin?: boolean): Promise<void> => {
    validate(data.id,"string","id",32,32)
    validate(data.userToken,"string","userToken",32,32)
    const userParams: DynamoDBGetParams = {
        TableName: process.env.USER_TABLE,
        Key: {id: data.id},
        ProjectionExpression: "id, userToken, tokenTime, admin"
    };
    const userTokenData = await performGet(userParams);
    if(userTokenData.id !== data.id || userTokenData.userToken !== data.userToken || Date.now()-(60000*tokenMinutesTimeout) > userTokenData.tokenTime) {
        throw new GeneratedError(ErrorTypes.InvalidToken);
    }
    if(!userTokenData.admin && requireAdmin) {
        throw new GeneratedError(ErrorTypes.InvalidPermissions)
    }
    await updateToken(data.id,data.userToken);
}

const updateToken = async (id: string, token: string) => {
    await updateUser(id,"set userToken = :t1, tokenTime = :t2",{
        ":t1": token,
        ":t2": Date.now()
    })
}

/*Username functions*/

export const getUserByUsername = async (username: string, allowedFailure: boolean = false): Promise<User> => {
    validate(username,"string","username",1,50)
    const getUserParams: DynamoDBQueryParams = {
        TableName: process.env.USER_TABLE,
        IndexName: 'get_by_username',
        KeyConditionExpression: 'username = :username',
        ExpressionAttributeValues: {
            ':username' : username.toLowerCase()
        },
        ProjectionExpression: 'username, id, classes, fullName, hashedPassword, admin, disableAudioAlerts'
    }
    const resultArray: User[] = await performQuery(getUserParams);
    const result = resultArray[0]
    if(result === null || typeof result === 'undefined') {
        if(allowedFailure) {
            return null
        }
        throw new GeneratedError(ErrorTypes.UserDoesNotExist);
    }
    return result;
}

export const userExists = async (username: string): Promise<boolean> => {
    const returnedUser = await getUserByUsername(username);
    return returnedUser !== null;
}

export const createUser = async (username: string, isAdmin: boolean, name: string, newClass?: string, newPermissionLevel?: PermissionLevel): Promise<User> => {
    validate(username,"email","Username must be email")
    validate(isAdmin,'boolean','isAdmin')
    validate(name,'string','name',1,50)
    const newUser: User = {
        id: randtoken.generate(32),
        username: username.toLowerCase(),
        admin: isAdmin,
        tokenTime: 0,
        classes: newClass ? [newClass]: [],
        fullName: name
    }
    const createUserQuery: DynamoDBPutParams = {
      TableName: process.env.USER_TABLE,
      Item: newUser
    }
    await performPut(createUserQuery)
    if(newClass) {
        await addExistingUserToClass(newClass,newUser.id,newPermissionLevel)
    }
    //TODO send email instead of logging
    // if(newClass) {
    //     const className =  await getClassName(newClass);
    //     const textBody = `
    //         Hi ${name},

    //         A new account has been setup for you for ${className}
    //         Your username is ${username}

    //         Please change your password after logging in!

    //         You can access the site by going to ${websiteURL}

    //         Do not reply to this email
    //     `;

    //     const htmlBody = `
    //     <!DOCTYPE html>
    //     <html>
    //         <head>
    //         </head>
    //         <body>
    //             <h3>Hello ${name},</h3>
    //             <p>A new account has been setup for you for ${className}</p>
    //             <p>Your username is ${username}</p>
    //             <p></p>
    //             <p>Please cahnge your password after logging in!</p>
    //             <p></p>
    //             <p>You can access the site by going to ${websiteURL}</p>
    //             <p></p>
    //             <p>Do not reply to this email</p>
    //         </body>
    //     </html>
    //     `
    //     await sendEmail(username, `New Account for ${className}`,textBody,htmlBody)
    // } else {
    //     const textBody = `
    //     Hi ${name},

    //     You have been made an administrator for the List site

    //     Your username is ${username}

    //     Please change your password after logging in!

    //     You can access the site by going to ${websiteURL}

    //     Do not reply to this email
    // `;

    // const htmlBody = `
    // <!DOCTYPE html>
    // <html>
    //     <head>
    //     </head>
    //     <body>
    //         <h3>Hello ${name},</h3>
    //         <p>You have been made an administrator for the List site</p>
    //         <p>Your username is ${username}</p>
    //         <p></p>
    //         <p>Please change your password after logging in!</p>
    //         <p></p>
    //         <p>You can access the site by going to ${websiteURL}</p>
    //         <p></p>
    //         <p>Do not reply to this email</p>
    //     </body>
    // </html>
    // `
    // await sendEmail(username, `New Admin Account for List Site`,textBody,htmlBody)
    // }
    //TODO remove
    return newUser
}

export const sendEmail = async (to: string, subject: string, textBody: string, htmlBody: string) => {
    validate(to,'email','To Field Email');
    //TODO replace with templace instead of explicit bodies
    const params = {
        Destination: {
          ToAddresses: [
            to
          ]
        },
        Message: { 
          Body: { 
            Html: {
             Charset: "UTF-8",
             Data: htmlBody
            },
            Text: {
             Charset: "UTF-8",
             Data: textBody
            }
           },
           Subject: {
            Charset: 'UTF-8',
            Data: subject
           }
          },
        Source: fromEmail,
        ReplyToAddresses: [
           fromEmail,
        ],
    };
    await new AWS.SES({apiVersion: '2010-12-01'}).sendEmail(params).promise()
}

/*Class functions*/

const getClassPermissions = async (id: string, classId: string): Promise<PermissionLevel> => {
    validate(id,"string","id",32,32)
    validate(classId,"string","classId",32,32)
    const request: DynamoDBGetParams = {
        TableName: process.env.CLASS_TABLE,
        ProjectionExpression: 'classUsers.#givenUser',
        Key: {id: classId},
        ExpressionAttributeNames: {
            '#givenUser': id
        }
    }
    const result: ClassObj = await performGet(request);
    if(result === null || typeof result === 'undefined' || typeof result.classUsers[id] === 'undefined') {
        throw new GeneratedError(ErrorTypes.ClassDoesNotExist);
    }
    return result.classUsers[id]
}

export const checkClassPermissions = async (id: string, classId: string, desiredPermissionLevel: PermissionLevel): Promise<PermissionLevel> => {
    const returnedLevel: PermissionLevel = await getClassPermissions(id, classId);
    if(returnedLevel < desiredPermissionLevel) {
        throw new GeneratedError(ErrorTypes.InvalidPermissions)
    }
    return returnedLevel;
}

export const getClassName = async(id: string): Promise<string> => {
    const request: DynamoDBGetParams = {
        TableName: process.env.CLASS_TABLE,
        ProjectionExpression: 'className',
        Key: {id: id}
    }
    const result: ClassObj = await performGet(request);
    return result.className;
}

export const addExistingUserToClass = async (classId: string, userId: string, permissionLevel: PermissionLevel) => {
    const addUserToClass: DynamoDBUpdateParams = {
        TableName: process.env.CLASS_TABLE,
        Key: {id:classId}, //https://stackoverflow.com/questions/41400538/append-a-new-object-to-a-json-array-in-dynamodb-using-nodejs
        UpdateExpression: `set classUsers.#userId = :permissionLevel`,
        ExpressionAttributeNames: {
            '#userId': userId
        },
        ExpressionAttributeValues: {
            ':permissionLevel': permissionLevel
        }
    }
    await performUpdate(addUserToClass)
}

/*Validation-Note min and max is INCLUSIVE!*/
export const validate = (data: any, type: string, field: string, min?: number, max?: number)=>{
    if(data !==null && typeof data === (type==='email'?'string':type)){
        if(type==="string" && ((typeof min!=="undefined" && data.length<min) || (typeof max!=="undefined" && data.length>max))){
            throw new GeneratedError(ErrorTypes.InvalidInput)
        }
        if(type==='number' && ((typeof min!=="undefined" && data<min) || (typeof max!=="undefined" && data>max))){
            throw new GeneratedError(ErrorTypes.InvalidInput)
        }
        if(type==='email' && data.length>1&&data.length<150){
            const regexp = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
            if(!regexp.test(data)){
                throw new GeneratedError(ErrorTypes.InvalidInput)
            }
        }
        return;
    }
    console.log(field) //TODO fix
    throw new GeneratedError(ErrorTypes.InvalidInput)
};

export const validateArray = (data: any, type: string, field: string, min?: number, max?: number, arrayMin: number = 0, arrayMax: number = 1000)=>{
    if(Array.isArray(data) && data.length>=arrayMin&& data.length<=arrayMax){
        data.forEach(item=>validate(item,type,field,min,max));
        return;
    }
    throw new GeneratedError(ErrorTypes.InvalidInput)
};