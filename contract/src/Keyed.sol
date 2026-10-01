// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Keyed - creator clubs with tradable keys on BNB Chain
/// @notice Each creator launches one club with a fixed maximum number of keys.
///         Keys are bought from and sold back to a bonding curve priced in BNB.
///         Every trade pays a 4% fee: 1% protocol, 3% creator. The creator can pass
///         part of their 3% to key holders, and that share can only go up.
/// @dev    Nobody, including the owner, can move the BNB that backs the curve.
///         The owner can only change where future protocol fees are credited.
contract Keyed {
    // ---------------------------------------------------------------- constants
    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant CREATOR_FEE_BPS = 300; // 3%
    uint256 public constant BPS = 10_000;
    uint256 public constant CURVE_DIVISOR = 16_000; // price of key n = n^2 / 16000 BNB
    uint256 public constant MIN_SUPPLY = 2;
    uint256 public constant MAX_SUPPLY = 5_000;
    uint256 public constant MAX_TRADE = 100;
    uint256 private constant PREC = 1e18;

    // ---------------------------------------------------------------- types
    struct Club {
        bool exists;
        uint32 maxSupply;
        uint32 supply;
        uint16 holderShareBps; // part of the creator fee shared with holders
        uint40 createdAt;
        uint256 accPerKey; // holder rewards per key, scaled by PREC
        string name;
        string handle;
        string avatar;
        string bio;
    }

    struct ClubView {
        address creator;
        string name;
        string handle;
        string avatar;
        string bio;
        uint256 maxSupply;
        uint256 supply;
        uint256 holderShareBps;
        uint256 holderCount;
        uint256 createdAt;
        uint256 buyPrice; // 1 key, fees included
        uint256 sellPrice; // 1 key, fees deducted (0 if it cannot be sold)
    }

    struct TradeRecord {
        address trader;
        address creator;
        uint128 value; // curve price, before fees
        uint32 amount;
        uint32 supplyAfter;
        bool isBuy;
        uint40 time;
    }

    // ---------------------------------------------------------------- storage
    address public owner;
    address public protocolFeeDestination;

    mapping(address => Club) private _clubs;
    address[] public creators;

    mapping(address => mapping(address => uint256)) public balanceOf; // creator => holder => keys
    mapping(address => mapping(address => uint256)) private _rewardDebt;
    mapping(address => mapping(address => uint256)) private _storedReward;

    mapping(address => address[]) private _holders;
    mapping(address => mapping(address => uint256)) private _holderIndex; // 1-based

    mapping(address => uint256) public credits; // withdrawable fees (creators + protocol)

    TradeRecord[] private _trades;
    mapping(address => uint256[]) private _clubTrades;

    uint256 public rewardPool; // BNB set aside for holder rewards

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- events
    event ClubLaunched(address indexed creator, uint256 maxSupply, uint256 holderShareBps);
    event ProfileUpdated(address indexed creator);
    event HolderShareRaised(address indexed creator, uint256 holderShareBps);
    event Trade(
        address indexed trader,
        address indexed creator,
        bool isBuy,
        uint256 amount,
        uint256 value,
        uint256 fee,
        uint256 supplyAfter
    );
    event RewardsClaimed(address indexed holder, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event ProtocolFeeDestinationSet(address destination);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------- modifiers
    modifier nonReentrant() {
        require(_lock == 1, "Reentrant call");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        protocolFeeDestination = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ProtocolFeeDestinationSet(msg.sender);
    }

    // ================================================================ creators

    /// @notice Launch your club. You receive key #1 for free.
    function launchClub(
        string calldata name,
        string calldata handle,
        string calldata avatar,
        string calldata bio,
        uint256 maxSupply,
        uint256 holderShareBps
    ) external {
        Club storage c = _clubs[msg.sender];
        require(!c.exists, "Club already exists");
        require(maxSupply >= MIN_SUPPLY && maxSupply <= MAX_SUPPLY, "Bad max supply");
        require(holderShareBps <= BPS, "Bad holder share");
        _checkProfile(name, handle, avatar, bio);

        c.exists = true;
        c.maxSupply = uint32(maxSupply);
        c.supply = 1;
        c.holderShareBps = uint16(holderShareBps);
        c.createdAt = uint40(block.timestamp);
        c.name = name;
        c.handle = handle;
        c.avatar = avatar;
        c.bio = bio;
        creators.push(msg.sender);

        balanceOf[msg.sender][msg.sender] = 1;
        _addHolder(msg.sender, msg.sender);

        emit ClubLaunched(msg.sender, maxSupply, holderShareBps);
        _record(msg.sender, msg.sender, true, 1, 0, 0, 1);
    }

    function updateProfile(
        string calldata name,
        string calldata handle,
        string calldata avatar,
        string calldata bio
    ) external {
        Club storage c = _clubs[msg.sender];
        require(c.exists, "No club");
        _checkProfile(name, handle, avatar, bio);
        c.name = name;
        c.handle = handle;
        c.avatar = avatar;
        c.bio = bio;
        emit ProfileUpdated(msg.sender);
    }

    /// @notice Raise the part of your creator fee that goes to holders. It can never go down.
    function raiseHolderShare(uint256 newShareBps) external {
        Club storage c = _clubs[msg.sender];
        require(c.exists, "No club");
        require(newShareBps > c.holderShareBps && newShareBps <= BPS, "Share can only go up");
        c.holderShareBps = uint16(newShareBps);
        emit HolderShareRaised(msg.sender, newShareBps);
    }

    // ================================================================ trading

    function buyKeys(address creator, uint256 amount) external payable nonReentrant {
        Club storage c = _clubs[creator];
        require(c.exists, "No club");
        require(amount > 0 && amount <= MAX_TRADE, "Bad amount");
        uint256 supply = c.supply;
        require(supply + amount <= c.maxSupply, "Sold out");

        uint256 value = getPrice(supply, amount);
        (uint256 pFee, uint256 cFee, uint256 hFee) = _fees(value, c.holderShareBps);
        uint256 total = value + pFee + cFee + hFee;
        require(msg.value >= total, "Not enough BNB");

        // pay existing holders first (buyer's previous keys included)
        if (hFee > 0) {
            c.accPerKey += (hFee * PREC) / supply;
            rewardPool += hFee;
        }
        _settle(creator, msg.sender);

        uint256 bal = balanceOf[creator][msg.sender];
        if (bal == 0) _addHolder(creator, msg.sender);
        bal += amount;
        balanceOf[creator][msg.sender] = bal;
        _rewardDebt[creator][msg.sender] = (bal * c.accPerKey) / PREC;
        c.supply = uint32(supply + amount);

        credits[protocolFeeDestination] += pFee;
        credits[creator] += cFee;

        _record(msg.sender, creator, true, amount, value, pFee + cFee + hFee, supply + amount);

        uint256 refund = msg.value - total;
        if (refund > 0) _send(msg.sender, refund);
    }

    function sellKeys(address creator, uint256 amount, uint256 minReceive) external nonReentrant {
        Club storage c = _clubs[creator];
        require(c.exists, "No club");
        require(amount > 0 && amount <= MAX_TRADE, "Bad amount");
        uint256 supply = c.supply;
        require(supply > amount, "Cannot sell the last key");
        uint256 bal = balanceOf[creator][msg.sender];
        require(bal >= amount, "Not enough keys");

        uint256 value = getPrice(supply - amount, amount);
        (uint256 pFee, uint256 cFee, uint256 hFee) = _fees(value, c.holderShareBps);
        uint256 payout = value - pFee - cFee - hFee;
        require(payout >= minReceive, "Price moved");

        _settle(creator, msg.sender);
        bal -= amount;
        balanceOf[creator][msg.sender] = bal;
        _rewardDebt[creator][msg.sender] = (bal * c.accPerKey) / PREC;
        if (bal == 0) _removeHolder(creator, msg.sender);
        uint256 newSupply = supply - amount;
        c.supply = uint32(newSupply);
        // remaining holders (seller's remaining keys included) share the holder fee
        if (hFee > 0) {
            c.accPerKey += (hFee * PREC) / newSupply;
            rewardPool += hFee;
        }

        credits[protocolFeeDestination] += pFee;
        credits[creator] += cFee;

        _record(msg.sender, creator, false, amount, value, pFee + cFee + hFee, newSupply);

        _send(msg.sender, payout);
    }

    // ================================================================ payouts

    /// @notice Claim your holder rewards from the given clubs.
    function claimRewards(address[] calldata clubList) external nonReentrant {
        uint256 total;
        for (uint256 i; i < clubList.length; ++i) {
            address creator = clubList[i];
            if (!_clubs[creator].exists) continue;
            _settle(creator, msg.sender);
            total += _storedReward[creator][msg.sender];
            _storedReward[creator][msg.sender] = 0;
        }
        if (total > rewardPool) total = rewardPool; // guards against rounding dust
        require(total > 0, "Nothing to claim");
        rewardPool -= total;
        emit RewardsClaimed(msg.sender, total);
        _send(msg.sender, total);
    }

    /// @notice Withdraw creator or protocol fees credited to you.
    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ================================================================ owner

    function setProtocolFeeDestination(address destination) external onlyOwner {
        require(destination != address(0), "Zero address");
        protocolFeeDestination = destination;
        emit ProtocolFeeDestinationSet(destination);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ================================================================ views

    /// @notice Curve price of `amount` keys starting at `supply`, before fees.
    function getPrice(uint256 supply, uint256 amount) public pure returns (uint256) {
        uint256 sum1 = supply == 0 ? 0 : ((supply - 1) * supply * (2 * (supply - 1) + 1)) / 6;
        uint256 last = supply + amount - 1;
        uint256 sum2 = (supply == 0 && amount == 1) ? 0 : (last * (last + 1) * (2 * last + 1)) / 6;
        return ((sum2 - sum1) * 1 ether) / CURVE_DIVISOR;
    }

    function getBuyPriceAfterFee(address creator, uint256 amount) public view returns (uint256) {
        Club storage c = _clubs[creator];
        if (!c.exists || amount == 0 || c.supply + amount > c.maxSupply) return 0;
        uint256 value = getPrice(c.supply, amount);
        (uint256 p, uint256 cf, uint256 h) = _fees(value, c.holderShareBps);
        return value + p + cf + h;
    }

    function getSellPriceAfterFee(address creator, uint256 amount) public view returns (uint256) {
        Club storage c = _clubs[creator];
        if (!c.exists || amount == 0 || c.supply <= amount) return 0;
        uint256 value = getPrice(c.supply - amount, amount);
        (uint256 p, uint256 cf, uint256 h) = _fees(value, c.holderShareBps);
        return value - p - cf - h;
    }

    function pendingRewards(address creator, address holder) public view returns (uint256) {
        Club storage c = _clubs[creator];
        uint256 accrued = (balanceOf[creator][holder] * c.accPerKey) / PREC;
        return _storedReward[creator][holder] + accrued - _rewardDebt[creator][holder];
    }

    function clubCount() external view returns (uint256) {
        return creators.length;
    }

    function clubExists(address creator) external view returns (bool) {
        return _clubs[creator].exists;
    }

    function getClub(address creator) public view returns (ClubView memory v) {
        Club storage c = _clubs[creator];
        if (!c.exists) return v;
        v.creator = creator;
        v.name = c.name;
        v.handle = c.handle;
        v.avatar = c.avatar;
        v.bio = c.bio;
        v.maxSupply = c.maxSupply;
        v.supply = c.supply;
        v.holderShareBps = c.holderShareBps;
        v.holderCount = _holders[creator].length;
        v.createdAt = c.createdAt;
        v.buyPrice = getBuyPriceAfterFee(creator, 1);
        v.sellPrice = getSellPriceAfterFee(creator, 1);
    }

    /// @notice Clubs in launch order, newest first.
    function getClubs(uint256 offset, uint256 limit) external view returns (ClubView[] memory out) {
        uint256 n = creators.length;
        if (offset >= n) return new ClubView[](0);
        uint256 count = n - offset < limit ? n - offset : limit;
        out = new ClubView[](count);
        for (uint256 i; i < count; ++i) out[i] = getClub(creators[n - 1 - offset - i]);
    }

    function getHolders(address creator, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory addrs, uint256[] memory balances)
    {
        address[] storage list = _holders[creator];
        uint256 n = list.length;
        if (offset >= n) return (new address[](0), new uint256[](0));
        uint256 count = n - offset < limit ? n - offset : limit;
        addrs = new address[](count);
        balances = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            addrs[i] = list[offset + i];
            balances[i] = balanceOf[creator][addrs[i]];
        }
    }

    /// @notice Every club `user` holds keys in or has unclaimed rewards from.
    function getHoldings(address user)
        external
        view
        returns (address[] memory clubList, uint256[] memory balances, uint256[] memory rewards)
    {
        uint256 n = creators.length;
        uint256 k;
        for (uint256 i; i < n; ++i) {
            address cr = creators[i];
            if (balanceOf[cr][user] > 0 || pendingRewards(cr, user) > 0) ++k;
        }
        clubList = new address[](k);
        balances = new uint256[](k);
        rewards = new uint256[](k);
        k = 0;
        for (uint256 i; i < n; ++i) {
            address cr = creators[i];
            uint256 b = balanceOf[cr][user];
            uint256 r = pendingRewards(cr, user);
            if (b > 0 || r > 0) {
                clubList[k] = cr;
                balances[k] = b;
                rewards[k] = r;
                ++k;
            }
        }
    }

    function tradeCount() external view returns (uint256) {
        return _trades.length;
    }

    /// @notice Latest trades across all clubs, newest first.
    function getRecentTrades(uint256 limit) external view returns (TradeRecord[] memory out) {
        uint256 n = _trades.length;
        uint256 count = n < limit ? n : limit;
        out = new TradeRecord[](count);
        for (uint256 i; i < count; ++i) out[i] = _trades[n - 1 - i];
    }

    /// @notice Latest trades in one club, newest first.
    function getClubTrades(address creator, uint256 limit) external view returns (TradeRecord[] memory out) {
        uint256[] storage ids = _clubTrades[creator];
        uint256 n = ids.length;
        uint256 count = n < limit ? n : limit;
        out = new TradeRecord[](count);
        for (uint256 i; i < count; ++i) out[i] = _trades[ids[n - 1 - i]];
    }

    // ================================================================ internal

    function _fees(uint256 value, uint256 holderShareBps)
        internal
        pure
        returns (uint256 pFee, uint256 cFee, uint256 hFee)
    {
        pFee = (value * PROTOCOL_FEE_BPS) / BPS;
        uint256 creatorTotal = (value * CREATOR_FEE_BPS) / BPS;
        hFee = (creatorTotal * holderShareBps) / BPS;
        cFee = creatorTotal - hFee;
    }

    function _settle(address creator, address user) internal {
        uint256 accrued = (balanceOf[creator][user] * _clubs[creator].accPerKey) / PREC;
        uint256 debt = _rewardDebt[creator][user];
        if (accrued > debt) _storedReward[creator][user] += accrued - debt;
        _rewardDebt[creator][user] = accrued;
    }

    function _addHolder(address creator, address user) internal {
        _holders[creator].push(user);
        _holderIndex[creator][user] = _holders[creator].length;
    }

    function _removeHolder(address creator, address user) internal {
        uint256 idx = _holderIndex[creator][user];
        if (idx == 0) return;
        address[] storage list = _holders[creator];
        address last = list[list.length - 1];
        list[idx - 1] = last;
        _holderIndex[creator][last] = idx;
        list.pop();
        delete _holderIndex[creator][user];
    }

    function _record(
        address trader,
        address creator,
        bool isBuy,
        uint256 amount,
        uint256 value,
        uint256 fee,
        uint256 supplyAfter
    ) internal {
        emit Trade(trader, creator, isBuy, amount, value, fee, supplyAfter);
        _clubTrades[creator].push(_trades.length);
        _trades.push(
            TradeRecord({
                trader: trader,
                creator: creator,
                value: uint128(value),
                amount: uint32(amount),
                supplyAfter: uint32(supplyAfter),
                isBuy: isBuy,
                time: uint40(block.timestamp)
            })
        );
    }

    function _checkProfile(string calldata name, string calldata handle, string calldata avatar, string calldata bio)
        internal
        pure
    {
        require(bytes(name).length > 0 && bytes(name).length <= 40, "Name: 1-40 chars");
        require(bytes(handle).length <= 32, "Handle: max 32 chars");
        require(bytes(avatar).length <= 300, "Avatar URL too long");
        require(bytes(bio).length <= 280, "Bio: max 280 chars");
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "BNB transfer failed");
    }
}
