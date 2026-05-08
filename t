PROPFIND https://sync-in.apps.janwie.be/remote.php/dav/files/janwiebe/Tmp/test HTTP/2.0
content-type: application/xml
ocs-apirequest: true
accept: application/xml
authorization: Basic amFud2llYmU6M3FwS0RLeS1obGpFYVRJX3BiOHM1NXJX
priority: u=3, i
accept-encoding: br;q=1.0, gzip;q=0.9, deflate;q=0.8
accept-language: nl-NL;q=1.0
content-length: 2213
depth: 1
x-nc-checkinterceptor: true
user-agent: Mozilla/5.0 (iOS) Nextcloud-iOS/33.0.7
x-nc-account: janwiebe https://sync-in.apps.janwie.be

<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
    <d:prop><d:displayname /><nc:share-download-limits /><d:getlastmodified /><d:getetag /><d:getcontenttype /><d:resourcetype /><d:quota-available-bytes /><d:quota-used-bytes /><d:getcontentlength /><permissions xmlns="http://owncloud.org/ns"/><id xmlns="http://owncloud.org/ns"/><fileid xmlns="http://owncloud.org/ns"/><size xmlns="http://owncloud.org/ns"/><favorite xmlns="http://owncloud.org/ns"/><share-types xmlns="http://owncloud.org/ns"/><owner-id xmlns="http://owncloud.org/ns"/><owner-display-name xmlns="http://owncloud.org/ns"/><comments-unread xmlns="http://owncloud.org/ns"/><checksums xmlns="http://owncloud.org/ns"/><downloadURL xmlns="http://owncloud.org/ns"/><data-fingerprint xmlns="http://owncloud.org/ns"/><creation_time xmlns="http://nextcloud.org/ns"/><upload_time xmlns="http://nextcloud.org/ns"/><is-encrypted xmlns="http://nextcloud.org/ns"/><has-preview xmlns="http://nextcloud.org/ns"/><mount-type xmlns="http://nextcloud.org/ns"/><rich-workspace xmlns="http://nextcloud.org/ns"/><note xmlns="http://nextcloud.org/ns"/><lock xmlns="http://nextcloud.org/ns"/><lock-owner xmlns="http://nextcloud.org/ns"/><lock-owner-editor xmlns="http://nextcloud.org/ns"/><lock-owner-displayname xmlns="http://nextcloud.org/ns"/><lock-owner-type xmlns="http://nextcloud.org/ns"/><lock-time xmlns="http://nextcloud.org/ns"/><lock-timeout xmlns="http://nextcloud.org/ns"/><system-tags xmlns="http://nextcloud.org/ns"/><file-metadata-size xmlns="http://nextcloud.org/ns"/><file-metadata-gps xmlns="http://nextcloud.org/ns"/><metadata-photos-exif xmlns="http://nextcloud.org/ns"/><metadata-photos-gps xmlns="http://nextcloud.org/ns"/><metadata-photos-original_date_time xmlns="http://nextcloud.org/ns"/><metadata-photos-place xmlns="http://nextcloud.org/ns"/><metadata-photos-size xmlns="http://nextcloud.org/ns"/><metadata-files-live-photo xmlns="http://nextcloud.org/ns"/><hidden xmlns="http://nextcloud.org/ns"/><share-permissions xmlns="http://open-collaboration-services.org/ns"/><share-permissions xmlns="http://open-cloud-mesh.org/ns"/>    </d:prop>
</d:propfind>

HTTP/2.0 207 
alt-svc: h3=":443"; ma=2592000
content-security-policy: default-src 'self' https://onlyoffice.tools.janwie.be ;script-src 'self' 'unsafe-inline' https://onlyoffice.tools.janwie.be;style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self'
content-type: application/xml; charset=utf-8
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
date: Sat, 02 May 2026 13:14:39 GMT
origin-agent-cluster: ?1
referrer-policy: no-referrer
strict-transport-security: max-age=31536000; includeSubDomains
via: 1.1 Caddy
x-content-type-options: nosniff
x-dns-prefetch-control: off
x-download-options: noopen
x-frame-options: SAMEORIGIN
x-permitted-cross-domain-policies: none
x-xss-protection: 0
content-length: 2110

<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ocs="http://open-collaboration-services.org/ns"><d:response><d:href>/remote.php/dav/files/janwiebe/Tmp/test/</d:href><d:propstat><d:prop><d:displayname>test</d:displayname><d:getlastmodified>Fri, 01 May 2026 17:02:03 GMT</d:getlastmodified><d:getetag>&quot;12326236-1777654923894&quot;</d:getetag><d:resourcetype><d:collection></d:collection></d:resourcetype><oc:id>00000000000012326236syncin</oc:id><oc:fileid>12326236</oc:fileid><oc:permissions>GRDNVCK</oc:permissions><ocs:share-permissions>31</ocs:share-permissions><oc:size>0</oc:size><oc:owner-id>janwiebe</oc:owner-id><oc:owner-display-name>Jan Wiebe</oc:owner-display-name><oc:share-types></oc:share-types><nc:has-preview>false</nc:has-preview><oc:comments-unread>0</oc:comments-unread><nc:is-encrypted>0</nc:is-encrypted><nc:mount-type></nc:mount-type><nc:lock>0</nc:lock><d:quota-used-bytes>233371806</d:quota-used-bytes><d:quota-available-bytes>-3</d:quota-available-bytes></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/janwiebe/Tmp/test/Containers-dark.png</d:href><d:propstat><d:prop><d:displayname>Containers-dark.png</d:displayname><d:getlastmodified>Fri, 01 May 2026 17:02:04 GMT</d:getlastmodified><d:getetag>W/&quot;bb7b9-19de47d8362&quot;</d:getetag><d:resourcetype></d:resourcetype><oc:id>00000000000000000096syncin</oc:id><oc:fileid>96</oc:fileid><oc:permissions>GRDNVW</oc:permissions><ocs:share-permissions>31</ocs:share-permissions><oc:size>767929</oc:size><oc:owner-id>janwiebe</oc:owner-id><oc:owner-display-name>Jan Wiebe</oc:owner-display-name><oc:share-types></oc:share-types><nc:has-preview>true</nc:has-preview><oc:comments-unread>0</oc:comments-unread><nc:is-encrypted>0</nc:is-encrypted><nc:mount-type></nc:mount-type><nc:lock>0</nc:lock><d:getcontenttype>image/png</d:getcontenttype><d:getcontentlength>767929</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>